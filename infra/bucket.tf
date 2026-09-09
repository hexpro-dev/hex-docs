# The bundle store itself, and the five settings that pin its defaults.
#
# Four of those five are already what AWS applies to a new bucket: block public access and
# bucket owner enforced ownership since April 2023, SSE-S3 default encryption since January
# 2023. Writing them is pinning rather than enabling, and it is worth the lines because AWS
# applies a default at CreateBucket and nothing afterwards keeps it there. Declared, a later
# change is drift this stack reports; undeclared, it is nothing.

locals {
  # The bucket ARN, composed from the name rather than read off the resource.
  #
  # A resource reference is unknown until apply, which would make every policy document in
  # this stack unknown at plan time, and `infra/tests/policies.tftest.hcl` could then assert
  # nothing without touching an account. Composed, the documents are fully known at plan and
  # the tests read the real rendered JSON.
  #
  # What a reference would have given for free is the dependency edge, so the one place that
  # needs one writes it as an explicit `depends_on`. See `bucket-policy.tf`.
  bucket_arn  = "arn:${data.aws_partition.current.partition}:s3:::${var.bucket_name}"
  objects_arn = "${local.bucket_arn}/*"
}

resource "aws_s3_bucket" "bundles" {
  bucket = var.bucket_name

  # The default, written out. A store whose stated policy is that nothing is ever garbage
  # collected must not have a `terraform destroy` that empties it first, and the value that
  # would do so is invisible while it is absent.
  force_destroy = false

  lifecycle {
    # The store's whole value is that a labelled sha resolves to the same bytes forever.
    # Destroying the bucket is the one operation that ends that, and unlike everything else
    # here it cannot be undone by putting a policy back. Removing this line is a deliberate
    # edit to a tracked file, which is the point of it being a line rather than a flag
    # somebody passes.
    prevent_destroy = true
  }
}

# Object Lock is deliberately not enabled, and nothing about S3 keeps it that way. AWS
# documents "Enable Object Lock on an existing S3 bucket" with console, CLI, SDK and REST
# procedures, and the only prerequisite is versioning, which this bucket has. Measured:
# `aws s3api put-object-lock-configuration help` on the installed CLI prints "You can enable
# Object Lock for new or existing buckets." So the flag being off is held by
# `s3:PutBucketObjectLockConfiguration` sitting in `DenyStoreReconfiguration`, and by nothing
# else.
#
# What it would buy is narrow. Even in COMPLIANCE mode a simple DELETE still succeeds and
# inserts a delete marker, which becomes the current version, and a later conditional PUT at
# that key then succeeds, so Object Lock does not make a key serve the same bytes forever.
# What it does protect is the old version, against a principal that can reach past the
# deletion deny in `bucket-policy.tf`. In this account that principal is the root user, and
# root can also remove the bucket policy, so the only configuration that would actually
# defend against it is COMPLIANCE mode with a retention period.
#
# That is the configuration this store must not have. hex-nfc's `docs/internal/` holds a
# device UDID and export-compliance notes, the deny-list scan is what keeps them out of a
# bundle, and COMPLIANCE retention would make one escape permanent and unremovable for the
# retention period.
#
# So the flag is off and its absence is a decision, and the asymmetry in what each direction
# costs is the reason it is also a deny. Turning Object Lock on is one API call an operator
# can make from the console; turning it back off is not possible at all, because AWS states
# that "after you enable Object Lock on a bucket, you can't disable Object Lock or suspend
# versioning for that bucket", and that "the only way to delete an object under the
# compliance mode before its retention date expires is to delete the associated AWS account".
# Every other refusal in this stack is undone by lifting the bucket policy. This one is the
# exception, which is why the guard has to stand in front of the call rather than behind a
# comment saying the call does not exist.

# All four settings, every time. Each argument defaults to false in the provider, so a
# resource naming three of them is not a partial pin, it is an active downgrade of the
# fourth.
resource "aws_s3_bucket_public_access_block" "bundles" {
  bucket                  = aws_s3_bucket.bundles.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ACLs disabled. The consequence being pinned is that a PUT carrying any ACL other than
# bucket-owner-full-control fails with a 400, which is what makes "the bucket owner owns
# every object" a property rather than a convention.
resource "aws_s3_bucket_ownership_controls" "bundles" {
  bucket = aws_s3_bucket.bundles.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "bundles" {
  bucket = aws_s3_bucket.bundles.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

    # `bucket_key_enabled` is deliberately absent. S3 Bucket Keys exist to reduce AWS KMS
    # request charges, SSE-S3 makes no KMS requests, so setting it buys nothing and reads
    # to the next person as evidence that this bucket is KMS encrypted when it is not.
    #
    # SSE-S3 rather than SSE-KMS is also what keeps the publisher policy the three
    # statements it is. Under SSE-KMS, `head-object --checksum-mode ENABLED` additionally
    # requires kms:Decrypt on the key, so the publish preflight would fail on a permission
    # that has nothing to do with S3, in a message naming neither the bucket nor this file.
  }
}

resource "aws_s3_bucket_versioning" "bundles" {
  bucket = aws_s3_bucket.bundles.id

  # A one way door, taken deliberately: the S3 API cannot return a bucket to unversioned,
  # only suspend it. The write-once refusal lives in application code holding valid
  # credentials and the deletion refusal lives in a policy the root user can remove, so a
  # version history is what turns whatever gets past both into something recoverable rather
  # than something gone. In normal operation this bucket has no noncurrent version at all,
  # so it costs nothing to run.
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "bundles" {
  bucket = aws_s3_bucket.bundles.id

  # One rule, and it deletes no object. AWS states it for this action outright: "this action
  # doesn't apply to objects. No objects are deleted by this lifecycle action." What it
  # removes is the parts of an upload that was started and never finished, which are billed
  # as storage and are invisible to ListObjectsV2, so nobody ever finds them. The write-once
  # deny in `bucket-policy.tf` makes that state reachable rather than hypothetical: it
  # exempts CreateMultipartUpload and UploadPart, because those cannot carry a conditional
  # header, and refuses only the CompleteMultipartUpload at the end.
  #
  # There is no expiration rule and there must never be one. Lifecycle is the single
  # mechanism that ignores the bucket policy entirely: "even if your bucket policy denies all
  # actions for all principals, your S3 Lifecycle configuration still functions as normal."
  # An expiration rule here is therefore the one edit that empties a store whose policy is
  # refusing every delete, which is why `s3:PutLifecycleConfiguration` is in the
  # reconfiguration deny and why `scripts/check-infra.mjs` fails on any `expiration` or
  # `transition` block or argument declared under this directory, whatever the prefix on its
  # name, and whether it is written plainly or as a `dynamic` block. That last case is not
  # hypothetical: the scan missed it until the step 6 review, and a `dynamic "expiration"`
  # plant was fmt clean, valid, and reported all clear.
  #
  # There is no `noncurrent_version_expiration` either. A write-once store should hold no
  # noncurrent version, so such a rule could only ever fire on something that has already
  # gone wrong, which is exactly the moment the old version is worth having.
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    # The empty filter is explicit. It is semantically identical to omitting the block on
    # recent 6.x providers, and omitting it emits an "Invalid Attribute Combination" warning
    # on the earlier ones the `~> 6.0` pin still allows. One line, and no warning noise on a
    # downgrade.
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # `transition_default_minimum_object_size` is deliberately not set. It governs transition
  # actions only, this configuration has none, and the provider plans its default as a known
  # value rather than as "known after apply", so omitting it produces no diff. Writing it
  # would imply the stack cares about transitions, which is the opposite of the policy.
}
