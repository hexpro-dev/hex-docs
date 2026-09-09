provider "aws" {
  region = var.region

  # The account this stack may touch, named by the operator rather than discovered. Without
  # it a stale `AWS_PROFILE` does not fail, it plans the whole stack against whichever
  # account the ambient credentials resolve to, and the first sign is a bucket in the wrong
  # organisation. With it the run stops before reading anything, naming both accounts.
  allowed_account_ids = var.allowed_account_ids

  # Applied to everything this stack creates that carries tags, so the store is
  # attributable in a bill and in a resource query without every resource repeating the
  # same two lines. `Name` is deliberately absent: it differs per resource, and a default
  # for it would win silently over the nothing each resource sets.
  default_tags {
    tags = merge({
      ManagedBy = "terraform"
      Stack     = "hex-docs-bundle-store"
    }, var.tags)
  }
}

# Who is signing, and which account that is. The `arn` attribute is read by the check below
# and by nothing else; `account_id` is what composes `local.oidc_provider_arn` in `oidc.tf`,
# so this data source is load bearing whatever happens to the check. One STS call per plan,
# and no permissions beyond the ones every caller has.
data "aws_caller_identity" "current" {}

# No API call and no credentials: the partition follows from the configured region. It is
# here rather than a literal "aws" so the ARNs are right in a partition this account is not
# in today, and so nothing has to remember that GovCloud spells it differently.
data "aws_partition" "current" {}

# A warning on every plan and every apply, for as long as it is true.
#
# The deploy identity in this estate is the AWS account root user with a long-lived access
# key, and that is the single largest weakness this stack sits on top of. Root is not the
# subject of any identity policy, cannot be scoped, cannot assume a role, and produces no
# per-operator attribution in CloudTrail. It is also, today, the only identity that exists,
# so refusing to apply would leave the stack unappliable and the warning unheard.
#
# A `check` block is the right shape precisely because it cannot fail a plan or an apply.
# `terraform test` is the exception: it treats a failed check assertion as a failure of the
# run block evaluating it and skips every run block after, so the `override_data` in
# `tests/policies.tftest.hcl` has to keep supplying an arn that does not end `:root`.
#
# It states the fact every time somebody touches the stack, and it goes quiet on its own the
# day the fact stops being true, with no flag for anybody to remember to flip.
# `infra/README.md` carries the migration.
check "deploy_identity_is_not_the_account_root_user" {
  assert {
    condition     = !endswith(data.aws_caller_identity.current.arn, ":root")
    error_message = "This stack is being applied by the AWS account root user. Every resource it creates is attributed to the account rather than to a person, and the credential doing it cannot be scoped by any policy in this stack. See the migration section of infra/README.md."
  }
}
