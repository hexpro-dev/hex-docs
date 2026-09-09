# The only control in this stack that binds the account root user.
#
# That is the whole reason the write-once guarantee lives in a bucket policy rather than in
# the publisher role. The profile this estate deploys with authenticates as the account root
# user, and root is not the subject of any identity policy: IAM cannot restrict it and it
# cannot assume a role. A resource-based Deny is the one thing that does apply to it. So
# every rule that has to hold against the operator's own terminal is here, and the role
# policy in `publishers.tf` holds only what has to be true of the GitHub publisher.
#
# There is no Allow statement. Both readers and the writer are principals in this account,
# and a same-account identity policy grants on its own, so an Allow here would widen the
# bucket without granting anybody anything they do not already have.
#
# The escape hatch is deliberate and is AWS's own: "the root principal in a bucket owner's
# AWS account can perform the GetBucketPolicy, PutBucketPolicy, and DeleteBucketPolicy API
# actions, even if their bucket policy explicitly denies the root principal's access." Those
# three actions are therefore not denied. Denying them would bind every principal except the
# one this stack is defending against, and would leave the policy changeable only by the
# account root user: the lift-apply-restore remedy below, and the object-deletion recovery in
# README.md, would both stop working for the non-root deploy identity the migration creates.
# Root can always unstick a wrong policy, which is what the carve-out is for, so the cost is
# root-only rather than a support ticket.
#
# What that costs is stated rather than papered over: whoever holds the root key can run
# `delete-bucket-policy` and then do as they like. Nothing in this account closes that; an
# Organizations resource control policy would, and there is no Organisation. What remains is
# that the removal is a separate, named, CloudTrail-recorded management event rather than a
# side effect of an `aws s3 rm`.

data "aws_iam_policy_document" "bundles" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    # Both ARNs. Bucket-level actions and object-level actions match different resource
    # ARNs, so naming one leaves half the API surface undenied and nothing reports it.
    resources = [local.bucket_arn, local.objects_arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }

    condition {
      # `BoolIfExists`, not the `Bool` AWS publishes, and the difference is whether this
      # statement holds for an unsigned request. `aws:PrincipalIsAWSService` is absent from
      # an anonymous call's request context, a plain operator against an absent key is
      # false, and every key in a condition block has to resolve true, so the published
      # spelling does not deny anonymous plaintext at all. The clause is here because AWS
      # redacts network context on service-to-service calls, so a bare SecureTransport deny
      # blocks service principals for a reason unrelated to what they were doing.
      test     = "BoolIfExists"
      variable = "aws:PrincipalIsAWSService"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyUnconditionalObjectCreation"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.objects_arn]

    condition {
      # `Null` with "true" means the key is absent, so this denies every put carrying no
      # If-None-Match header. S3 constrains the value separately, since PutObject "Expects
      # the '*' (asterisk) character", so presence plus the API's own validation gives the
      # semantics the policy alone cannot state.
      #
      # `s3:if-none-match` is on exactly one IAM action, `s3:PutObject`, and that one action
      # covers the whole object-creation surface: CopyObject, CreateMultipartUpload,
      # UploadPart, UploadPartCopy and CompleteMultipartUpload are not separate IAM actions.
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["true"]
    }

    condition {
      # Without this, every multipart upload breaks at its first part. CreateMultipartUpload,
      # UploadPart and UploadPartCopy authorise as s3:PutObject and cannot carry a
      # conditional header. The key is true only for the requests that actually create the
      # object and can carry one, PutObject and CompleteMultipartUpload, which is exactly the
      # set this deny should reach. AWS says so in both directions on its own enforcement
      # page, and its Example 2 is this statement with `s3:if-match` in place of the key
      # below.
      test     = "Bool"
      variable = "s3:ObjectCreationOperation"
      values   = ["true"]
    }

    # There is deliberately no `aws:PrincipalIsAWSService` exemption on this statement or on
    # the deletion one below, and the asymmetry with the transport deny is the decision
    # rather than an oversight. The transport clause is about a mechanism: a service
    # principal would be denied there for a reason that has nothing to do with what it was
    # doing. Here the question is who may create an object in a bundle store, and the answer
    # is one publisher running one command. An AWS service writing here is by definition not
    # a bundle publish. The cost is real and is in README.md: this bucket cannot be the
    # target of server access logging, CloudTrail delivery or load balancer logs. All three
    # authorise as `s3:PutObject`, none of them can carry an If-None-Match header, and this
    # statement has no service-principal exemption, so each fails with a 403 rather than
    # quietly.
    #
    # Replication is not in that list and never belonged in it. A replication write
    # authorises as `s3:ReplicateObject`, which this statement does not name and which
    # carries no conditional-write key to test. What refuses it is `DenyReplicationIntoStore`
    # below, and nothing here.
  }

  statement {
    sid    = "DenyObjectDeletion"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    # This is the half that turns no-overwrite into immutability, and without it the
    # statement above reads far stronger than it is. On a versioned bucket a simple DELETE is
    # not blocked by a conditional-write deny: it inserts a delete marker, the marker becomes
    # the current version, and AWS is explicit that "if the current object version is a
    # delete marker, the write operation succeeds". So anybody who can delete can free a
    # published key and write different bytes to it, at an address a site already serves.
    #
    # The product answer to a bad bundle is that it is never labelled, not that it is
    # deleted. Removing a published object is therefore a deliberate two-step act: lift this
    # policy as the root user, delete, put the policy back. README.md carries the commands.
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]

    resources = [local.objects_arn]
  }

  statement {
    sid    = "DenyReplicationIntoStore"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    # The inbound half of replication, which neither object deny above reaches.
    #
    # A replication rule is configured on the source bucket, so any other bucket in this
    # account can name this one as its destination, and the destination-side writes authorise
    # as `s3:ReplicateObject`, `s3:ReplicateDelete` and `s3:ReplicateTags`. None of the three
    # is `s3:PutObject`, so `DenyUnconditionalObjectCreation` never evaluates them; none is
    # `s3:DeleteObject`, so `DenyObjectDeletion` never evaluates them either. Measured with
    # `aws iam simulate-custom-policy` against the applied document before this statement
    # existed: all three returned allowed in the same run where the three denies beside them
    # returned explicitDeny.
    #
    # What that reached is exactly the two states the statements above exist to refuse.
    # `ReplicateObject` writes a new current version at an already published key, and
    # `ReplicateDelete` writes a delete marker, which is the state `DenyObjectDeletion`'s own
    # comment says then admits a conditional PUT.
    #
    # Same-account replication needs no destination bucket policy at all, so the replication
    # role's identity policy alone was sufficient and nothing here had to be granted. The
    # cross-account case is refused for a different reason, which is why
    # `s3:ObjectOwnerOverrideToBucketOwner` is not in the list: this document carries no
    # Allow, and a cross-account write needs one. `s3:ReplicateObjectAnnotation` is out
    # because no documented route reaches it.
    #
    # `s3:PutReplicationConfiguration` in `DenyStoreReconfiguration` below is the other
    # direction and does not substitute for this one. Deleting either leaves the direction it
    # closed open, and the other statement says nothing about it.
    actions = [
      "s3:ReplicateDelete",
      "s3:ReplicateObject",
      "s3:ReplicateTags",
    ]

    resources = [local.objects_arn]
  }

  statement {
    sid    = "DenyStoreReconfiguration"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    # Six actions, and they are not all the same kind of thing. Five close a documented route
    # around the two object denies above. None of those five is speculative, and none is
    # something this stack performs after its first apply, which is what makes denying them
    # affordable.
    #
    #   s3:DeleteBucket                  the shortest route: delete the container.
    #   s3:PutLifecycleConfiguration     the one mechanism that ignores this entire policy.
    #                                    AWS: "even if your bucket policy denies all actions
    #                                    for all principals, your S3 Lifecycle configuration
    #                                    still functions as normal." An expiration rule is a
    #                                    delete the deletion deny cannot see.
    #   s3:PutReplicationConfiguration   PutBucketReplication is called on the source bucket,
    #                                    so denying it here is what stops this bucket
    #                                    becoming a replication source, which would copy
    #                                    every published bundle into a bucket carrying none
    #                                    of this policy. The inbound direction is
    #                                    `DenyReplicationIntoStore` above, and neither
    #                                    statement closes the other's direction.
    #   s3:PutBucketVersioning           suspending versioning removes the recovery half.
    #   s3:PutBucketPublicAccessBlock    the setting between a private store and the open
    #                                    internet. DeletePublicAccessBlock authorises as this
    #                                    same action, so both directions are covered.
    #
    # The sixth, `s3:PutBucketObjectLockConfiguration`, is here for the opposite reason. It
    # is not a route around a deny; it is the one route into a configuration this store must
    # not have. S3 enables Object Lock on a bucket that already exists as long as the bucket
    # is versioned, and this one is, so the flag being off in `bucket.tf` is held by this line
    # rather than by the API. It is also the only entry in this statement that lifting the
    # policy cannot undo: Object Lock cannot be disabled once enabled, versioning can then
    # never be suspended, and `bucket.tf` records why COMPLIANCE retention is the state this
    # store must not reach. Every other row here refuses a change somebody could make and
    # then reverse.
    #
    # `s3:PutObjectRetention` and `s3:PutObjectLegalHold` are absent rather than written in
    # as depth, and the second reason is why. AWS requires Object Lock to be enabled on the
    # bucket before either can be set, so the bucket-level deny is what puts them out of
    # reach. They are also object-level actions and this statement names the bucket ARN
    # alone: measured with `aws iam simulate-custom-policy` against an object ARN, a deny
    # listing them here returns allowed, so writing them in would refuse nothing while
    # reading as though it did.
    #
    # `s3:PutBucketPolicy`, `s3:GetBucketPolicy` and `s3:DeleteBucketPolicy` are absent on
    # purpose, for the reason in this file's header.
    #
    # The price is that changing any of the six is now a two-step act for Terraform as well
    # as for a person: lift the policy, apply, put it back. That is intended. Reconfiguring a
    # write-once store should not be something a plan does on the way past.
    actions = [
      "s3:DeleteBucket",
      "s3:PutBucketObjectLockConfiguration",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketVersioning",
      "s3:PutLifecycleConfiguration",
      "s3:PutReplicationConfiguration",
    ]

    resources = [local.bucket_arn]
  }
}

resource "aws_s3_bucket_policy" "bundles" {
  bucket = aws_s3_bucket.bundles.id
  policy = data.aws_iam_policy_document.bundles.json

  # Every bucket-level setting in `bucket.tf` is ordered before the policy, so the policy is
  # applied last and, on a destroy, removed first. Terraform destroys in reverse creation
  # order, so this one `depends_on` gets both directions.
  #
  # Three of the five have to be here. `s3:PutLifecycleConfiguration`, `s3:PutBucketVersioning`
  # and `s3:PutBucketPublicAccessBlock` are in `DenyStoreReconfiguration`, so a policy applied
  # before them 403s the put. Ownership controls and default encryption are not denied and
  # would not fail today; they are ordered anyway because the edge is free, and because
  # "order every bucket setting" stays correct on the day an action joins the deny list, where
  # "order the denied ones" quietly stops being correct at that moment and nothing reports it.
  #
  # The edges have to be explicit because `local.bucket_arn` is composed from the name rather
  # than read off the resource, which is what makes the policy document known at plan time
  # and therefore assertable by `infra/tests/policies.tftest.hcl` with no account. Delete
  # these lines and a first apply can fail with a 403 on the lifecycle put, in a graph that
  # looks correct.
  #
  # A steady-state re-apply is unaffected: the provider reads these five and writes nothing
  # when nothing has changed.
  depends_on = [
    aws_s3_bucket_lifecycle_configuration.bundles,
    aws_s3_bucket_ownership_controls.bundles,
    aws_s3_bucket_public_access_block.bundles,
    aws_s3_bucket_server_side_encryption_configuration.bundles,
    aws_s3_bucket_versioning.bundles,
  ]
}
