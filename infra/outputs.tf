# What an operator copies out, and what `scripts/check-stack.mjs` reads back.
#
# Three of these carry the account id: `oidc_provider_arn`, `publisher_role_arns` and
# `publisher_trust_policy_json`, whose Federated principal is that same provider ARN. The
# four S3-ARN documents do not, because an S3 ARN names no account. That is fine where they
# go: `terraform output` writes to a terminal and to state, and the state lives in a private
# bucket. Nothing here writes a file into this repository, and `scripts/check-stack.mjs`
# reads them through `terraform output -json` and prints none of them.

output "bucket_name" {
  description = "The bundle store. Set as the HEXDOCS_BUCKET repository variable in each publishing repository, and as HEXDOCS_BUCKET on a deploy host that runs hexdocs prefetch."
  value       = aws_s3_bucket.bundles.bucket
}

output "bucket_arn" {
  description = "The bundle store's ARN."
  value       = aws_s3_bucket.bundles.arn
}

output "oidc_provider_arn" {
  description = "The GitHub Actions OIDC provider this stack owns. No script reads it: it is what an operator copies out when diagnosing a refused AssumeRoleWithWebIdentity, which is the first real test of a trust policy and the one failure Access Analyzer cannot see coming."
  value       = aws_iam_openid_connect_provider.github.arn
}

output "publisher_role_arns" {
  description = "Publisher role ARNs, keyed as var.publishers is. Set each as the HEXDOCS_PUBLISH_ROLE repository variable in that repository."
  value       = { for key, role in aws_iam_role.publisher : key => role.arn }
}

output "publisher_projects" {
  description = "Project prefixes per publisher, so the live verification checks a role against the prefixes it is meant to own rather than against its own idea of them."
  value       = { for key, publisher in var.publishers : key => publisher.projects }
}

# The three rendered documents below exist for `scripts/check-stack.mjs`, which feeds them to
# `aws accessanalyzer validate-policy`. Rendering them from the same `aws_iam_policy_document`
# the resources use is what makes that a check: a second copy written for the validator would
# be validating a document nothing applies.
output "bucket_policy_json" {
  description = "The rendered bucket policy, for validate-policy as a RESOURCE_POLICY."
  value       = data.aws_iam_policy_document.bundles.json
}

output "publisher_policy_json" {
  description = "Rendered publisher permissions policies, for validate-policy as an IDENTITY_POLICY."
  value       = { for key, document in data.aws_iam_policy_document.publisher : key => document.json }
}

output "publisher_trust_policy_json" {
  description = "Rendered publisher trust policies, for validate-policy as a RESOURCE_POLICY with the AssumeRolePolicyDocument resource type."
  value       = { for key, document in data.aws_iam_policy_document.publisher_trust : key => document.json }
}

output "reader_policy_json" {
  description = "The read-only policy for a future non-root deploy identity. Attached to nothing today, because the identity that reads bundles is the account root user. See reader.tf."
  value       = data.aws_iam_policy_document.reader.json
}
