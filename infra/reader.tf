# There is no reader role, and the absence is the decision.
#
# The only thing that reads a bundle is `hexdocs prefetch`, run from the `prebuild` hook of a
# consuming website during a deploy. Measured: that runs on the deploy host, it signs with
# the ambient `AWS_PROFILE` the deploy pins, and that profile authenticates as the AWS
# account root user. Root cannot be the subject of an identity policy, cannot assume a role,
# and already has unconditional access to every bucket in the account. So a reader role would
# have no principal to trust, a reader managed policy would have nothing to attach to, and
# either one would sit in the account looking like an access control while controlling
# nothing. This repository refuses that shape everywhere else.
#
# What exists instead is the document, rendered and output. It costs no resource, it cannot
# drift from the bucket name because it is computed from it, and on the day the deploy host
# stops being root it is one `aws iam create-policy --policy-document` away from being real.
# `scripts/check-stack.mjs` feeds it to `aws accessanalyzer validate-policy` along with the
# policies that are attached, so it is checked rather than merely written down.
#
# Two details worth keeping when that day comes. `s3:ListBucket` is in it although prefetch
# never lists: without it S3 answers a GetObject on a missing key with 403 rather than 404,
# and a version label pointing at a sha nobody published would then report an access denial
# instead of naming the label and the commit. And the grant is the whole bucket rather than a
# project prefix list, because one website mounts several documented projects and a
# prefix-scoped reader would need an edit every time one is added, whose cost is a deploy
# that aborts. Write access is the thing worth scoping, and a reader has none.

data "aws_iam_policy_document" "reader" {
  statement {
    sid       = "ListBundles"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
  }

  statement {
    sid       = "ReadBundles"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = [local.objects_arn]
  }
}
