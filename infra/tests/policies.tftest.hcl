# What the rendered policies actually say, asserted without touching an account.
#
# `command = plan` throughout, with a provider configured from static rubbish and every skip
# flag set, so no AWS call is made and no credential is needed. That is what lets this run in
# the same CI job as `terraform validate`, on a runner declaring `permissions: contents: read`
# and holding no role to assume.
#
# The reason this file exists rather than a careful read of the HCL: every statement it
# asserts is a deny whose absence is invisible. A missing `s3:DeleteObjectVersion` renders as
# a policy that reads correct, applies cleanly and leaves the store deletable. There is no
# plan diff, no warning and no error, and the only thing that would ever notice is somebody
# deleting a published bundle.
#
# Every assertion reaches into the JSON through `try(..., "absent")`. Without it, deleting a
# condition block does not fail the assertion, it throws "Unsupported attribute" and the run
# aborts before the message is printed, so the reader gets a line number instead of the
# sentence saying what the deletion did.

provider "aws" {
  region                      = "ap-southeast-2"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = true
}

# The one data source in the stack that costs an API call. Overridden rather than removed,
# because `oidc.tf` composes `local.oidc_provider_arn` out of its `account_id` and every
# trust-policy assertion below reads that ARN, so removing it would leave those assertions
# with nothing to read. Its `arn` also feeds the `check` block in `providers.tf` that warns
# while the deploy identity is the account root user, and the value below is load bearing for
# a reason nothing else states: a failed check assertion fails the run block evaluating it and
# skips every run block after, so the arn here must not end `:root`. That is what `not-root`
# is saying.
# The account id every fixture below uses is generated, never written.
#
# `scripts/lint.mjs` fails on a twelve digit run anywhere in this repository, because that is
# the shape of an AWS account id and this repository is public. These tests need one, the
# variable validation refuses anything shorter, and the alternative to generating it would be
# an exemption naming this file. This repository has exactly one exemption mechanism and it is
# scoped to `fixtures/`, so the honest move is to write no literal at all. A `locals` block
# would be tidier and is not allowed in a test file, so `format` is repeated in the one place
# that accepts a function call. An `override_data` value accepts neither a function nor a
# variable, so the account id it supplies is not account-shaped at all: nothing asserts on the
# OIDC provider ARN it composes, and a value that is obviously not an account id is better
# here than one that looks like somebody's.

override_data {
  target = data.aws_caller_identity.current
  # Without this the override lands at apply time, and every run block here is a plan, so the
  # composed OIDC provider ARN would still be unknown and every trust-policy assertion would
  # abort rather than fail.
  override_during = plan
  values = {
    account_id = "account-under-test"
    arn        = "arn:aws:iam::account-under-test:role/not-root"
    id         = "account-under-test"
    user_id    = "AIDANOTREAL"
  }
}

variables {
  allowed_account_ids = [format("%012d", 4321)]
  bucket_name         = "hexdocs-bundles-under-test"

  # Two publishers, because one cannot show the property that matters most: that a role
  # reaches its own project prefixes and nobody else's. A single-publisher fixture passes
  # every assertion below even if the `for_each` were dropped and both roles shared one
  # document.
  publishers = {
    alpha = {
      owner         = "test-org"
      repository    = "alpha-app"
      repository_id = "1234567890"
      projects      = ["alpha"]
    }
    beta = {
      owner         = "test-org"
      repository    = "beta-app"
      repository_id = "9876543210"
      branch        = "release"
      projects      = ["beta", "beta-legacy"]
    }
  }
}

run "the_bucket_policy_is_five_denies_and_nothing_else" {
  command = plan

  assert {
    condition = tolist([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement : s.Sid
      ]) == tolist([
      "DenyInsecureTransport",
      "DenyUnconditionalObjectCreation",
      "DenyObjectDeletion",
      "DenyReplicationIntoStore",
      "DenyStoreReconfiguration",
    ])
    error_message = "The bucket policy is not the five expected denies, in order. This is the only control in the stack that binds the account root user: a statement removed here stops binding it, and one added binds it to something nobody reviewed."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement : s.Effect == "Deny"
    ])
    error_message = "A statement in the bucket policy is not a Deny. Same-account access already comes from identity policies, so an Allow here would widen the bucket to a principal no identity policy named."
  }
}

run "an_unconditional_put_is_denied_and_multipart_still_starts" {
  command = plan

  assert {
    condition = try(one([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement :
      s if s.Sid == "DenyUnconditionalObjectCreation"
    ]).Condition.Null["s3:if-none-match"], "absent") == "true"
    error_message = "The write-once deny no longer fires on a put carrying no If-None-Match header, which is every ordinary put: an SDK default, an S3 console upload, and `aws s3 cp` without --no-overwrite."
  }

  assert {
    condition = try(one([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement :
      s if s.Sid == "DenyUnconditionalObjectCreation"
    ]).Condition.Bool["s3:ObjectCreationOperation"], "absent") == "true"
    error_message = "The write-once deny lost its ObjectCreationOperation clause, so it now fires on CreateMultipartUpload, UploadPart and UploadPartCopy. Those three authorise as s3:PutObject and cannot carry a conditional header, so every multipart upload into this bucket would fail at its first part."
  }

  assert {
    condition = try(one([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement :
      s if s.Sid == "DenyUnconditionalObjectCreation"
    ]).Resource, "absent") == "arn:aws:s3:::hexdocs-bundles-under-test/*"
    error_message = "The write-once deny does not name the object ARN. PutObject acts on objects, so a deny naming the bucket ARN matches nothing and refuses nothing."
  }
}

run "deletion_is_denied_in_both_spellings" {
  command = plan

  assert {
    # Sorted on both sides. `aws_iam_policy_document` does not render an action list in the
    # order it was declared, so a positional comparison here fails on a policy that is
    # correct, which is the worst kind of red row.
    condition = try(sort(tolist(one([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement :
      s if s.Sid == "DenyObjectDeletion"
    ]).Action)), ["absent"]) == sort(tolist(["s3:DeleteObject", "s3:DeleteObjectVersion"]))
    error_message = "The deletion deny is not both of DeleteObject and DeleteObjectVersion. Without DeleteObject the store is no-overwrite rather than immutable, because a simple DELETE inserts a delete marker and the next conditional put at that key then succeeds. Without DeleteObjectVersion the versions that make a delete recoverable can be purged one at a time."
  }
}

run "replication_cannot_write_into_the_store" {
  command = plan

  assert {
    # Sorted, for the same reason the deletion assertion is.
    condition = try(sort(tolist(one([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement :
      s if s.Sid == "DenyReplicationIntoStore"
      ]).Action)), ["absent"]) == sort(tolist([
      "s3:ReplicateDelete",
      "s3:ReplicateObject",
      "s3:ReplicateTags",
    ]))
    error_message = "The replication deny is not the three destination-side replication actions. A replication rule on any other bucket in this account can name this one as its destination, and those writes authorise as s3:ReplicateObject, s3:ReplicateDelete and s3:ReplicateTags. None of them is s3:PutObject or s3:DeleteObject, so neither object deny evaluates them: measured, all three returned allowed against the applied policy before this statement existed."
  }

  assert {
    condition = try(one([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement :
      s if s.Sid == "DenyReplicationIntoStore"
    ]).Resource, "absent") == "arn:aws:s3:::hexdocs-bundles-under-test/*"
    error_message = "The replication deny does not name the object ARN. All three replication actions act on objects, so a deny naming the bucket ARN matches nothing and refuses nothing."
  }

  assert {
    # The other direction, and the reason it is a separate assertion rather than a longer
    # action list on the one above: `s3:PutReplicationConfiguration` is called on the source
    # bucket, so it lives in `DenyStoreReconfiguration` against the bucket ARN and stops this
    # bucket becoming a replication source. Neither statement closes the other's direction,
    # and the failure mode this pins is somebody deleting one because the other looks like it
    # covers replication.
    condition = try(contains(tolist(one([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement :
      s if s.Sid == "DenyStoreReconfiguration"
    ]).Action), "s3:PutReplicationConfiguration"), false)
    error_message = "The reconfiguration deny no longer refuses s3:PutReplicationConfiguration, so this bucket can be made a replication source and every published bundle copied into a bucket carrying none of this policy. DenyReplicationIntoStore does not cover this: it is the inbound direction."
  }
}

run "the_ways_around_the_object_denies_are_closed_and_the_way_back_in_is_not" {
  command = plan

  assert {
    condition = try(sort(tolist(one([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement :
      s if s.Sid == "DenyStoreReconfiguration"
      ]).Action)), ["absent"]) == sort(tolist([
      "s3:DeleteBucket",
      "s3:PutBucketObjectLockConfiguration",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketVersioning",
      "s3:PutLifecycleConfiguration",
      "s3:PutReplicationConfiguration",
    ]))
    error_message = "The reconfiguration deny is not the six expected actions. Five close a documented route around the object denies, and s3:PutLifecycleConfiguration is the sharpest of those: lifecycle ignores bucket policies entirely, so an expiration rule is a delete no other statement in this policy can see. s3:PutBucketObjectLockConfiguration is the sixth and is a different kind of thing, the only one whose loss is permanent: S3 enables Object Lock on an existing versioned bucket, it can never be disabled afterwards, versioning can then never be suspended, and COMPLIANCE retention would make an internal document that escaped the deny-list scan unremovable for the retention period."
  }

  assert {
    # All three of the carved-out actions, because the error message names all three and a
    # guard that checks two of them is a guard whose own sentence overstates it.
    condition = length([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement :
      s if contains(flatten([try(tolist(s.Action), [s.Action])]), "s3:PutBucketPolicy") ||
      contains(flatten([try(tolist(s.Action), [s.Action])]), "s3:DeleteBucketPolicy") ||
      contains(flatten([try(tolist(s.Action), [s.Action])]), "s3:GetBucketPolicy")
    ]) == 0
    error_message = "A statement denies a bucket-policy action. AWS gives the account root user a carve-out for exactly GetBucketPolicy, PutBucketPolicy and DeleteBucketPolicy, so denying them binds every principal except the one this policy defends against, and leaves the policy changeable only by root, which breaks the lift-apply-restore remedy for every other principal."
  }
}

run "plain_http_is_denied_without_blocking_aws_services" {
  command = plan

  assert {
    condition = try(one([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement :
      s if s.Sid == "DenyInsecureTransport"
    ]).Condition.BoolIfExists["aws:PrincipalIsAWSService"], "absent") == "false"
    error_message = "The transport deny does not carry BoolIfExists on aws:PrincipalIsAWSService. Plain Bool is what AWS publishes and it does not hold for an unsigned request, because the key is absent from an anonymous request context and a plain operator against an absent key is false."
  }

  assert {
    condition = try(length(tolist(one([
      for s in jsondecode(data.aws_iam_policy_document.bundles.json).Statement :
      s if s.Sid == "DenyInsecureTransport"
    ]).Resource)), 0) == 2
    error_message = "The transport deny names one ARN rather than two. Bucket-level actions and object-level actions match different resource ARNs, so naming one leaves half the API surface reachable over plain HTTP and nothing reports it."
  }
}

run "the_trust_policy_pins_one_branch_of_one_repository" {
  command = plan

  assert {
    # One statement, allowing one action, to one federated principal. Every condition below
    # scopes that one statement, and all of them are inert beside a second statement carrying
    # none: a trust policy with an extra unconditioned Allow is a role anybody with any token
    # can assume, and every assertion after this one would still pass.
    condition = try(
      length(jsondecode(data.aws_iam_policy_document.publisher_trust["alpha"].json).Statement) == 1 &&
      jsondecode(data.aws_iam_policy_document.publisher_trust["alpha"].json).Statement[0].Sid == "GitHubActionsOnOneBranchOfOneRepository" &&
      jsondecode(data.aws_iam_policy_document.publisher_trust["alpha"].json).Statement[0].Effect == "Allow" &&
      jsondecode(data.aws_iam_policy_document.publisher_trust["alpha"].json).Statement[0].Action == "sts:AssumeRoleWithWebIdentity" &&
      strcontains(jsondecode(data.aws_iam_policy_document.publisher_trust["alpha"].json).Statement[0].Principal.Federated, "oidc-provider/token.actions.githubusercontent.com"),
      false
    )
    error_message = "The trust policy is not one GitHubActionsOnOneBranchOfOneRepository statement allowing sts:AssumeRoleWithWebIdentity to the GitHub OIDC provider."
  }

  assert {
    condition     = try(jsondecode(data.aws_iam_policy_document.publisher_trust["alpha"].json).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:repository_id"], "absent") == "1234567890"
    error_message = "The trust policy does not pin the immutable repository id. Repository names are reclaimable after a rename or a deletion, and a policy resting on the name alone can be satisfied by a repository somebody else created."
  }

  assert {
    condition     = try(jsondecode(data.aws_iam_policy_document.publisher_trust["beta"].json).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:ref"], "absent") == "refs/heads/release"
    error_message = "The trust policy does not pin the branch from the publisher entry. Without it a tag push or any contributor branch mints a publishing credential."
  }

  assert {
    condition     = try(jsondecode(data.aws_iam_policy_document.publisher_trust["alpha"].json).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"], "absent") == "sts.amazonaws.com"
    error_message = "The trust policy does not pin the audience. GitHub mints a token for whatever audience a workflow asks for, so without this a token minted for another consumer is replayable against this role."
  }

  assert {
    condition = try(tolist(jsondecode(data.aws_iam_policy_document.publisher_trust["alpha"].json).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"]), ["absent"]) == tolist([
      "repo:test-org/alpha-app:ref:refs/heads/main",
      "repo:test-org@*/alpha-app@*:ref:refs/heads/main",
    ])
    error_message = "The subject condition is not both spellings of one repository on one branch. The subject is what refuses a pull request, whose subject carries no :ref: segment at all, and the second spelling is what GitHub emits after the immutable-subject cutover."
  }

  assert {
    # A string scan rather than a structural one, because the failure is a spelling: an
    # `...IfExists` operator evaluates true when its key is absent, so one misspelled claim
    # name would silently grant instead of denying, and nothing in Access Analyzer or in the
    # toolchain catches that.
    condition = alltrue([
      for key, document in data.aws_iam_policy_document.publisher_trust :
      !strcontains(document.json, "IfExists")
    ])
    error_message = "A trust policy uses an ...IfExists condition operator. Absence evaluates true under those operators, so a misspelled OIDC claim name grants rather than denies, which is the one mistake here that fails open."
  }
}

run "a_publisher_reaches_its_own_prefixes_and_no_others" {
  command = plan

  assert {
    condition = try(tolist(one([
      for s in jsondecode(data.aws_iam_policy_document.publisher["beta"].json).Statement :
      s if s.Sid == "WriteOnceIntoOwnProjectPrefixes"
      ]).Resource), ["absent"]) == tolist([
      "arn:aws:s3:::hexdocs-bundles-under-test/beta/*",
      "arn:aws:s3:::hexdocs-bundles-under-test/beta-legacy/*",
    ])
    error_message = "A publisher's write grant is not exactly its own project prefixes, each with the separating slash. The slash is load bearing: `<bucket>/beta*` matches beta-legacy as well as beta, and would match another repository's project the day one is named that way."
  }

  assert {
    # The read grant, held to exactly the same prefixes as the write grant. A GetObject scoped
    # to the whole bucket would let one repository's CI read another's bundles, and nothing
    # else in this file would notice: every other assertion here is about writing.
    condition = try(tolist(one([
      for s in jsondecode(data.aws_iam_policy_document.publisher["beta"].json).Statement :
      s if s.Sid == "ReadOwnProjectPrefixes"
      ]).Resource), ["absent"]) == tolist([
      "arn:aws:s3:::hexdocs-bundles-under-test/beta/*",
      "arn:aws:s3:::hexdocs-bundles-under-test/beta-legacy/*",
    ])
    error_message = "The publisher's read grant is not exactly its own project prefixes. HeadObject authorises as s3:GetObject, so this one statement covers the preflight, the reconcile and the manifest fetch, and widening it hands one repository's CI a read of every other project in the store."
  }

  assert {
    condition     = !strcontains(data.aws_iam_policy_document.publisher["alpha"].json, "beta")
    error_message = "The alpha publisher's policy mentions beta's prefixes. Each role is scoped to the projects its own repository owns, and crossing that turns write-once from a guarantee into a race between two repositories."
  }

  assert {
    condition = try(one([
      for s in jsondecode(data.aws_iam_policy_document.publisher["alpha"].json).Statement :
      s if s.Sid == "WriteOnceIntoOwnProjectPrefixes"
    ]).Condition.Null["s3:if-none-match"], "absent") == "false"
    error_message = "The publisher's put grant no longer requires If-None-Match. The bucket policy says the same thing, and this is the copy that survives an operator lifting the bucket policy to recover from something."
  }

  assert {
    condition = try(one([
      for s in jsondecode(data.aws_iam_policy_document.publisher["alpha"].json).Statement :
      s if s.Sid == "ListOwnProjectPrefixes"
    ]).Resource, "absent") == "arn:aws:s3:::hexdocs-bundles-under-test"
    error_message = "The listing grant does not name the bucket ARN. s3:ListBucket is a bucket-level action, so a grant on the object ARN matches nothing, and without it S3 answers the publish preflight head on a missing key with 403 instead of 404."
  }

  assert {
    condition = try(tolist(one([
      for s in jsondecode(data.aws_iam_policy_document.publisher["beta"].json).Statement :
      s if s.Sid == "ListOwnProjectPrefixes"
    ]).Condition.StringLike["s3:prefix"]), ["absent"]) == tolist(["beta/*", "beta-legacy/*"])
    error_message = "The listing condition is not the publisher's own prefixes with a trailing star. The client lists `<project>/<sha>/ast-1/`, so a StringEquals on the bare project matches nothing and denies the reconcile."
  }

  assert {
    condition = try(one([
      for s in jsondecode(data.aws_iam_policy_document.publisher["alpha"].json).Statement :
      s if s.Sid == "DenyEverythingElse"
    ]).Effect, "absent") == "Deny"
    error_message = "The publisher policy has no explicit deny. Every action in it is already denied implicitly, and the point of writing them is that `aws iam simulate-principal-policy` then reports explicitDeny rather than implicitDeny, which is the difference between a decision and an omission."
  }
}

# The variable validations, made to fail.
#
# Every other run block in this file asserts what a correct stack renders. These three assert
# that three of the refusals actually refuse, which is a different property and was untested
# until now: a validation nobody has ever watched fail is not known to work, and a
# `can(regex(...))` whose pattern matches everything is invisible in every other way. There is
# no plan diff and no error; the first sign would be a role named something IAM accepts and
# nobody meant.
#
# Three rather than all eight, chosen because their refusal is the part a reader cannot get
# from the condition alone: two of them encode a measured number, and the third fires on the
# interaction between two variables that are each legal on their own.

run "a_role_name_prefix_that_is_not_iam_friendly_is_refused_at_plan" {
  command = plan

  variables {
    role_name_prefix = "hexdocs/publisher"
  }

  # Refused here rather than at apply, which matters because roles order after the bucket, the
  # bucket policy and the OIDC provider: an apply-time refusal leaves a half-applied stack.
  expect_failures = [var.role_name_prefix]
}

run "a_prefix_and_key_that_compose_a_role_name_over_64_characters_are_refused" {
  command = plan

  variables {
    # 48 characters, which the prefix's own regex allows, plus a hyphen and a 16 character key
    # is 65. Each variable is legal on its own and the pair is not, which is why the check is
    # on the map rather than on the prefix.
    role_name_prefix = "hexdocs-publisher-for-one-app-repository-abcdefg"

    publishers = {
      nepali-companion = {
        owner         = "test-org"
        repository    = "alpha-app"
        repository_id = "1234567890"
        projects      = ["alpha"]
      }
    }
  }

  expect_failures = [var.publishers]
}

run "a_repository_name_shorter_than_four_characters_is_refused" {
  command = plan

  variables {
    publishers = {
      alpha = {
        owner         = "test-org"
        repository    = "app"
        repository_id = "1234567890"
        projects      = ["alpha"]
      }
    }
  }

  # Measured with `aws accessanalyzer validate-policy` on the rendered trust policy: one, two
  # and three character repository names each return WILDCARD_USAGE_TOO_PERMISSIVE and four is
  # clean, because the immutable-subject pattern puts only `/<repository>@` before its second
  # wildcard and the rule wants six literal characters. Without this refusal the name plans
  # green and fails `pnpm check:stack` instead, with an issue code and a JSON path naming
  # neither the repository nor its length.
  expect_failures = [var.publishers]
}
