#!/usr/bin/env bash
#
# The state backend, created once, before the first `terraform init`.
#
# Every Terraform stack has this chicken and egg, and in most repositories it lives in
# somebody's shell history. It is a script instead so that it is repeatable, so that it says
# what it did, and so that the second person to need it does not reconstruct five API calls
# from a paragraph of prose.
#
# It is idempotent by construction. Every step either checks first or uses an API that
# replaces rather than appends, so a second run changes nothing and prints "already". That
# matters more than it sounds: the state bucket is the one resource nothing else can
# recreate, so the safe operation has to be the one an operator reaches for without thinking.
#
# The four settings are re-applied on every run rather than only at creation. An operator who
# turned versioning off in the console last year finds out here, on the next run, rather than
# on the day they need a state file back.
#
# No value below is baked in. The account id is compared against the caller's real account
# before anything is created, which is the whole safety story: every call after that point is
# a write, and the failure it prevents is a state bucket created in the wrong organisation,
# which nobody notices until a second stack starts reading it.
#
# Usage, with the values from infra/README.md:
#
#   AWS_PROFILE=<profile> \
#   AWS_REGION=<region> \
#   HEXDOCS_ACCOUNT_ID=<account id> \
#   HEXDOCS_STATE_BUCKET=<project>-terraform-state \
#   infra/bootstrap.sh

set -euo pipefail

for name in AWS_PROFILE AWS_REGION HEXDOCS_ACCOUNT_ID HEXDOCS_STATE_BUCKET; do
	if [ -z "${!name:-}" ]; then
		echo "bootstrap: ${name} is not set. See the header of this file." >&2
		exit 2
	fi
done

region="${AWS_REGION}"
bucket="${HEXDOCS_STATE_BUCKET}"

caller_account="$(aws sts get-caller-identity --query Account --output text)"
caller_arn="$(aws sts get-caller-identity --query Arn --output text)"

if [ "${caller_account}" != "${HEXDOCS_ACCOUNT_ID}" ]; then
	echo "bootstrap: credentials resolve to account ${caller_account}, not ${HEXDOCS_ACCOUNT_ID}. Refusing." >&2
	exit 1
fi

case "${caller_arn}" in
*:root)
	# Printed rather than refused. Today this is the only identity in the account, so
	# refusing would leave no way to run the bootstrap at all. Saying it every time is what
	# keeps it a thing somebody is choosing rather than a thing nobody remembers. The same
	# fact is asserted on every plan by the `check` block in providers.tf.
	echo "bootstrap: warning, signing as the account root user. See the migration section of infra/README.md."
	;;
esac

echo "bootstrap: account ${caller_account}, region ${region}, bucket ${bucket}"

if aws s3api head-bucket --bucket "${bucket}" >/dev/null 2>&1; then
	echo "bootstrap: bucket already exists"
else
	# LocationConstraint is required everywhere except us-east-1, where supplying it is an
	# error. This estate is in neither position to need the branch: it is ap-southeast-2, so
	# the constraint is unconditional and this comment is the branch that is not written.
	aws s3api create-bucket \
		--bucket "${bucket}" \
		--region "${region}" \
		--create-bucket-configuration "LocationConstraint=${region}" >/dev/null
	echo "bootstrap: bucket created"
fi

aws s3api put-public-access-block \
	--bucket "${bucket}" \
	--public-access-block-configuration \
	"BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null
echo "bootstrap: public access blocked, all four settings"

aws s3api put-bucket-ownership-controls \
	--bucket "${bucket}" \
	--ownership-controls "Rules=[{ObjectOwnership=BucketOwnerEnforced}]" >/dev/null
echo "bootstrap: ACLs disabled"

aws s3api put-bucket-encryption \
	--bucket "${bucket}" \
	--server-side-encryption-configuration \
	'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null
echo "bootstrap: SSE-S3 default encryption"

# Versioning on the state bucket is a different decision from versioning on the bundle store,
# and it is not optional. Terraform state is overwritten on every apply, so this is the only
# thing that recovers the state as it stood before a bad one, and that recovery is why
# `terraform force-unlock` and a hand-edited state file are not the first resort.
aws s3api put-bucket-versioning \
	--bucket "${bucket}" \
	--versioning-configuration "Status=Enabled" >/dev/null
echo "bootstrap: versioning enabled"

echo
echo "bootstrap: done. Initialise the stack with:"
echo
echo "  terraform -chdir=infra init \\"
echo "    -backend-config=\"bucket=${bucket}\" \\"
echo "    -backend-config=\"key=hex-docs/infra.tfstate\" \\"
echo "    -backend-config=\"region=${region}\""
echo
