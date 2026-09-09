# One publisher role per app repository, from `var.publishers`. A second repository is one
# map entry, and every condition below is written exactly once.

locals {
  # What each trust policy pins, computed here rather than inline in the policy document.
  #
  # Two reasons, and the second is the one that matters. Inline, these strings are buried in
  # a `data` block; as locals they are named, and `infra/tests/policies.tftest.hcl` asserts
  # the exact subject patterns without touching an account. The spelling of these strings is
  # the entire access-control boundary, and a misspelled claim name is the one mistake in
  # this file that fails closed with no diagnosis: `aws accessanalyzer validate-policy` does
  # not check claim names in a provider-prefixed namespace at all. Measured: a trust policy
  # carrying a deliberately misspelled claim returned one finding, about something else.
  publisher_claims = {
    for key, publisher in var.publishers : key => {
      ref = "refs/heads/${publisher.branch}"

      # Both spellings of the subject, as a two-value StringLike, which IAM ORs.
      #
      # GitHub changed the default subject on 2026-07-15. A repository created before then
      # emits `repo:<owner>/<repo>:ref:<ref>`; one created, renamed or transferred after it
      # emits `repo:<owner>@<owner id>/<repo>@<repo id>:ref:<ref>`, and an organisation-level
      # opt-in moves every repository at once with no warning. Measured for hex-nfc:
      # `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` reports
      # `use_immutable_subject false`, so it emits the first spelling today. Carrying both
      # makes that flip a no-op here instead of an outage.
      #
      # The `@*` wildcards stand exactly where the numeric ids go, so the pattern is still
      # pinned to one repository in one organisation. They are safe on their own terms and
      # `repository_id` pins the identity regardless.
      #
      # This deliberately does not survive a repository rename, and that is the trade. The
      # shape that would, `repo:<owner>*:ref:<ref>`, matches every repository in the
      # organisation and rests the whole of the scoping on `repository_id`, a condition key
      # AWS documents and which nobody here has yet watched STS honour end to end. A rename
      # is a deliberate act whose failure is one denied assume and one map edit; the other
      # shape's failure would be silent breadth.
      subjects = [
        "repo:${publisher.owner}/${publisher.repository}:ref:refs/heads/${publisher.branch}",
        "repo:${publisher.owner}@*/${publisher.repository}@*:ref:refs/heads/${publisher.branch}",
      ]

      # The object ARNs this repository may read and write, one per project it owns. The
      # trailing slash before the star is load bearing: `<bucket>/hex*` matches hex-nfc as
      # well as hex, and `<bucket>/hex/*` does not.
      object_arns = [for project in publisher.projects : "${local.bucket_arn}/${project}/*"]

      # The listing prefixes, which are a different condition on a different action. The
      # client lists `<project>/<sha>/ast-1/`, so this is StringLike with a trailing star
      # rather than StringEquals on the bare project.
      list_prefixes = [for project in publisher.projects : "${project}/*"]
    }
  }
}

data "aws_iam_policy_document" "publisher_trust" {
  for_each = var.publishers

  statement {
    sid     = "GitHubActionsOnOneBranchOfOneRepository"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      # GitHub mints a token for whatever audience a workflow asks for. Without this, a token
      # minted for another consumer is replayable against this role.
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      # The immutable identity of the repository. AWS: "A name that is freed by renaming or
      # deletion can be claimed by a different account", and it recommends exactly this key.
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_id"
      values   = [each.value.repository_id]
    }

    condition {
      # A tag push carries refs/tags/<tag> and any other branch carries its own name, so this
      # is what stops a contributor who can push a branch from publishing.
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:ref"
      values   = [local.publisher_claims[each.key].ref]
    }

    condition {
      # Load bearing beyond the two above, because it is what refuses a pull request. A
      # pull_request token's subject is `repo:<owner>/<repo>:pull_request` with no `:ref:`
      # segment at all, so neither pattern matches. That case is why the ref condition is not
      # sufficient by itself: for `pull_request_target` the ref claim is the base branch,
      # refs/heads/main, and a ref condition alone would pass a token minted from a fork's
      # code.
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.publisher_claims[each.key].subjects
    }

    # Three deliberate absences, each with its reason, because an absent condition looks
    # identical to a forgotten one.
    #
    # `repository_owner_id` is not here, though AWS's own worked example uses it. Repository
    # ids are globally unique, so it scopes nothing `repository_id` has not already scoped,
    # and its mapping is disputed: a third-party analysis of the February 2026 STS claim
    # launch lists it among the claims STS does not map, against AWS's documentation, which
    # lists it. An unmapped key is absent from the request context, a StringEquals on an
    # absent key is false, and the result would be that every publish is denied. That is a
    # total outage bought for no additional scope.
    #
    # `job_workflow_ref` is not here either. It would pin the token to one workflow file, and
    # what that closes is a compromised third-party action inside some other workflow on the
    # same branch minting a token and assuming this role.
    #
    # What that buys is one write into `<project>/<sha>/ast-N/`, which no site serves until
    # somebody labels the sha. The cost that is not obvious is the second half: write-once
    # then refuses the legitimate publish at that same address forever, because `reconcile`
    # in `kit/src/commands/publish.ts` fails on a stray or mismatched object and the
    # publisher is denied DeleteObject, so the commit has to be superseded by the next one
    # rather than republished.
    #
    # Against that, the claim's behaviour under the immutable-subject change is unverified,
    # so pinning it exactly is a rename hazard. It is one condition to add if a bundle ever
    # becomes visible before it is labelled, or if losing a commit's publish address ever
    # costs more than a fresh commit. Note that it does not close the case on its own: the
    # publish workflow is itself the workflow that runs third-party actions.
    #
    # No `...IfExists` operator appears anywhere in this file, on any claim. Absence
    # evaluates true under those operators, so one misspelled claim name would silently grant
    # instead of denying, and nothing in the toolchain or in Access Analyzer catches that.
    # Every condition here is a plain operator, so the cost of a typo is a denial.
  }
}

data "aws_iam_policy_document" "publisher" {
  for_each = var.publishers

  statement {
    sid       = "ListOwnProjectPrefixes"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]

    condition {
      # Not optional, and for a real S3 behaviour rather than for tidiness. Without
      # s3:ListBucket, S3 answers HeadObject on a key that is not there with 403 rather than
      # 404. The publish preflight is exactly that call on a first publish, so a role holding
      # GetObject and no ListBucket turns every first publish into an access denial the
      # operator reads as a broken role. Measured against two public buckets, one granting
      # anonymous list and one not, on the same missing key.
      #
      # The condition is what keeps the grant from being the whole bucket: a listing with no
      # prefix, or with another repository's prefix, does not match and is denied.
      test     = "StringLike"
      variable = "s3:prefix"
      values   = local.publisher_claims[each.key].list_prefixes
    }
  }

  statement {
    sid    = "ReadOwnProjectPrefixes"
    effect = "Allow"
    # HeadObject has no IAM action of its own; it authorises as s3:GetObject. That single
    # action therefore covers three of the four calls the recipe table can make: the
    # preflight head, the per-object head during reconciliation, and the manifest get.
    actions   = ["s3:GetObject"]
    resources = local.publisher_claims[each.key].object_arns
  }

  statement {
    sid       = "WriteOnceIntoOwnProjectPrefixes"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = local.publisher_claims[each.key].object_arns

    condition {
      # `Null` with "false" means the key is present, so a put is allowed only when it
      # carries If-None-Match.
      #
      # This is not redundant with the bucket policy's deny. The bucket policy is the thing
      # the root user can remove, and the moment it is removed, for a recovery or by
      # accident, this condition is what keeps the publisher write-once. Two independent
      # statements of one rule, in the two places with different failure modes.
      #
      # There is no companion statement exempting multipart, unlike the bucket policy. That
      # is deliberate: the toolchain's only write is `aws s3api put-object`, a single
      # request, so a multipart upload from this role is by definition not a bundle publish.
      # The bucket policy keeps its ObjectCreationOperation clause because it governs the
      # whole bucket and must not break a writer this stack does not know about; this policy
      # governs one publisher whose every call is a literal in `kit/src/exec/recipes.ts`.
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyEverythingElse"
    effect = "Deny"

    # Every one of these is already denied implicitly, and writing them makes the boundary
    # legible in two places that matter: a reader of this file, and
    # `aws iam simulate-principal-policy`, which reports explicitDeny rather than
    # implicitDeny and so distinguishes "this was decided" from "nobody granted it".
    #
    # The other half of the reason is the one `WriteOnceIntoOwnProjectPrefixes` makes four
    # statements above: the bucket policy is the document the root user can remove, and these
    # five survive that.
    #
    # What notices this statement going is `POLICY_DOCUMENT_SIDS` in
    # `scripts/check-infra.mjs`, which is offline and on the ladder, and the assertion in
    # `infra/tests/policies.tftest.hcl`. Measured, so that nobody trims this list expecting a
    # credentialled run to catch it: a simulation that probes only `s3:DeleteObject` and
    # `s3:DeleteObjectVersion` cannot see this statement removed, because the bucket policy's
    # own `DenyObjectDeletion` returns explicitDeny for both either way. `s3:PutObjectAcl` and
    # `s3:AbortMultipartUpload` are the two that move, and they are the probes worth having.
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:PutBucketPolicy",
      "s3:PutObjectAcl",
    ]

    resources = [local.bucket_arn, local.objects_arn]
  }
}

resource "aws_iam_role" "publisher" {
  for_each = var.publishers

  name               = "${var.role_name_prefix}-${each.key}"
  description        = "Publishes hex-docs bundles for ${each.value.owner}/${each.value.repository} into its own project prefixes. Assumed only by GitHub Actions OIDC."
  assume_role_policy = data.aws_iam_policy_document.publisher_trust[each.key].json

  # The floor rather than a preference. `aws-actions/configure-aws-credentials` requests a
  # one hour session by default, and an assume asking for longer than the role's maximum
  # fails outright. A publish takes one to two minutes, so a shorter value would be tempting
  # and would break the action's default with an error about durations rather than about this
  # line.
  max_session_duration = 3600

  # The edge the composed provider ARN in `oidc.tf` gives up. IAM validates that a Federated
  # principal exists when the role is created, so without this a first apply can order the
  # role before the provider and fail with MalformedPolicyDocument.
  depends_on = [aws_iam_openid_connect_provider.github]
}

resource "aws_iam_role_policy" "publisher" {
  for_each = var.publishers

  name   = "bundle-store"
  role   = aws_iam_role.publisher[each.key].id
  policy = data.aws_iam_policy_document.publisher[each.key].json
}
