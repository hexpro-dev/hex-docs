# The account's GitHub Actions OIDC provider.
#
# There is one per account and this stack owns it, because at the time it was written the
# account had none: `aws iam list-open-id-connect-providers` returned an empty list. A second
# stack that declares its own fails at apply with EntityAlreadyExists, which is the honest
# failure; the fix then is for that stack to take a data source, not for this one to guess.

locals {
  # The provider's ARN, composed rather than read off the resource, for the same reason
  # `local.bucket_arn` is: a resource attribute is unknown until apply, and a trust policy
  # document that references one renders as "(known after apply)" in every plan. That costs
  # two things worth more than the reference. `infra/tests/policies.tftest.hcl` cannot assert
  # a single claim without an account, and an operator reviewing a plan cannot read the
  # access-control boundary they are about to approve.
  #
  # The dependency edge a reference would have given is written as an explicit `depends_on`
  # on each publisher role in `publishers.tf`. IAM validates that a Federated principal
  # exists when a role is created, so without that edge a first apply can fail with
  # MalformedPolicyDocument on a graph that looks correct.
  oidc_provider_arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  # The audience `aws-actions/configure-aws-credentials` requests, which is the hard-coded
  # default of the action's `audience` input. A mismatch here fails every publish at
  # AssumeRoleWithWebIdentity with a message naming neither the audience nor this file.
  client_id_list = ["sts.amazonaws.com"]

  # `thumbprint_list` is deliberately absent. It has been optional on both provider majors,
  # IAM retrieves the top intermediate CA thumbprint itself when none is given, and the
  # action's own documentation says an explicit thumbprint "will be ignored". Committing the
  # two literals that circulate would be dead weight that reads, a year from now, like a
  # rotation obligation somebody has to service.

  lifecycle {
    # Every publisher role's trust policy names this provider. Replacing it, which a change
    # to `url` would do, breaks every publish in the account at once and cannot be undone by
    # putting the roles back, because their trust policies would point at the destroyed ARN.
    prevent_destroy = true
  }
}
