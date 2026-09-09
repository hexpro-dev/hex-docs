# The bundle store

One private S3 bucket, one GitHub Actions OIDC provider, and one publisher role per app
repository. This is step 6 of the plan, and it is the only place in hex-docs that talks to
AWS.

Nothing here names an account, a bucket or a role. This repository is public, so every value
that identifies the estate arrives at apply time through an untracked
`infra/local.auto.tfvars` and leaves through `terraform output`. There is deliberately no
example tfvars file: a file whose whole purpose is to look like real values and be filled in
is the highest-probability route to a real bucket name being committed. The placeholder block
is below instead, and `pnpm lint` fails on a twelve-digit account id or an `arn:aws:` literal
anywhere in the repository.

## What it provisions

| Resource             | Why                                                                             |
| -------------------- | ------------------------------------------------------------------------------- |
| `aws_s3_bucket`      | the bundle store. Keys are `<project>/<commit sha>/ast-<major>/<key>`           |
| public access block  | all four settings, pinned rather than enabled                                   |
| ownership controls   | ACLs disabled, so a PUT carrying one fails rather than changing ownership       |
| default encryption   | SSE-S3. Not KMS: see the comment in `bucket.tf`                                 |
| versioning           | the only thing that makes a deletion recoverable                                |
| lifecycle            | one rule, which deletes no object: it aborts incomplete multipart uploads       |
| bucket policy        | five denies, and the only control in the stack that binds the account root user |
| OIDC provider        | `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`             |
| a role per publisher | prefix-scoped, write-once, assumable only from one branch of one repository     |

There is no reader role. `reader.tf` says why at length, and outputs the policy that becomes
one on the day this estate stops deploying as the account root user.

## Once per account: the state backend

The stack cannot create its own state bucket. `bootstrap.sh` does, and re-running it is a
no-op.

```sh
export AWS_PROFILE=<profile>
export AWS_REGION=<region>
export HEXDOCS_ACCOUNT_ID=<twelve digits>
export HEXDOCS_STATE_BUCKET=<project>-terraform-state   # the estate convention

aws sts get-caller-identity        # confirm the account before anything writes
./infra/bootstrap.sh               # idempotent; prints the init line when it finishes
```

`<project>` on that one line is the estate's repository name, matching the same placeholder in
`bootstrap.sh`'s header; everywhere else on this page it is a docs project id. This is the
state bucket, not the bundle store, and the real name is not written down here for the reason
in the paragraph at the top.

## Once: initialise, and fill in the values

```sh
terraform -chdir=infra init \
  -backend-config="bucket=$HEXDOCS_STATE_BUCKET" \
  -backend-config="key=hex-docs/infra.tfstate" \
  -backend-config="region=$AWS_REGION"

git add infra/.terraform.lock.hcl
```

The lock file is committed, because `~> 6.0` floats and the lock is what makes CI and a laptop
verify the same provider. It has to carry the hashes for both platforms, or an init on the
Linux runner rewrites it:

```sh
terraform -chdir=infra providers lock -platform=linux_amd64 -platform=darwin_arm64
```

Then write `infra/local.auto.tfvars`, which is untracked and auto-loaded. Every value is
yours; nothing below is a real one.

```hcl
allowed_account_ids = ["<twelve digits>"]
bucket_name         = "<the bundle store bucket>"

publishers = {
  hex-nfc = {
    owner         = "<github org>"
    repository    = "<repository name>"
    repository_id = "<gh api repos/OWNER/REPO -q .id>"
    projects      = ["<project ids from that repository's docs/site/docs.json>"]
  }
}
```

Every placeholder above is deliberately the wrong shape, so a copy that was never edited
fails at `terraform plan` naming the field rather than planning a stack against something
plausible. `repository_id` is a string of digits, not a number: IAM condition values are
strings, and a number would render as one in the JSON and match nothing. `branch` defaults to
`main`.

`bucket_name` is fixed for the life of the stack. The bucket carries `prevent_destroy`, so a
changed name is refused at plan rather than replacing the bucket.

## Every change, including the first apply

```sh
terraform -chdir=infra fmt -recursive
pnpm check:infra                                  # offline: fmt, validate, the policy tests, the invariants
terraform -chdir=infra plan -out=infra.tfplan
terraform -chdir=infra apply infra.tfplan
pnpm check:stack                                  # read-only, against the applied stack
```

`pnpm verify` runs `check:infra` as a ladder row, so a badly formatted or invalid stack fails
a pull request with no credentials anywhere. `check:stack` needs credentials and is
deliberately not on the ladder: a row that cannot run reports NOT RUN, and NOT RUN fails the
run, so a credentialled row would fail `pnpm verify` on every machine without an AWS profile,
which is most of them and all of CI.

One thing to expect the first time you read a plan for drift rather than for a change: a
refresh-only plan of a correct stack reports three resources changed, for deprecated
`aws_s3_bucket` attributes, the role's `inline_policy` mirror and empty tag maps. That is
provider noise rather than drift, and `pnpm check:stack` is what answers the question the plan
is being asked, because it compares the applied bucket policy against the rendered one
statement by statement.

## Wiring a repository up

```sh
terraform -chdir=infra output bucket_name
terraform -chdir=infra output publisher_role_arns

gh variable set HEXDOCS_BUCKET --repo <owner>/<repo> \
  --body "$(terraform -chdir=infra output -raw bucket_name)"
gh variable set HEXDOCS_PUBLISH_ROLE --repo <owner>/<repo> --body '<the role ARN for that key>'
```

Variables rather than secrets, matching `kit/src/templates/workflow.ts`. Neither value is a
credential: the role ARN is useless without a token GitHub will only mint for that one
repository on that one branch, and the bucket refuses every unauthenticated request. What
they are is estate-identifying, which is why they are set on the repository rather than
committed to it.

Then run `hexdocs init` in the app repository, commit, and push to `main`. The first workflow
run is the only real test of the trust policy: `aws accessanalyzer validate-policy` does not
check OIDC claim names at all, so a misspelled one is invisible until STS refuses.

## Adding a second app repository

One map entry, then plan and apply. Nothing else changes: the role, both policy documents and
the prefix scoping are all `for_each` over `var.publishers`.

## Renaming a publisher

A `publishers` map key and `role_name_prefix` are both part of the role's name, and a role
name cannot be changed in place. Either edit shows up in the plan as the role destroyed and
recreated, with `publisher_role_arns` changing. The ARN lives outside this stack, so after the
apply re-run the `gh variable set HEXDOCS_PUBLISH_ROLE` line in "Wiring a repository up" for
that repository, or its next publish fails at `AssumeRoleWithWebIdentity`. The other five
fields are safe: they rewrite the two policy documents and update the role in place.

## Undoing a mistake

Everything in the bucket policy binds the account root user too. That is the point of it, and
it means recovery is a deliberate three-step act rather than a single command. AWS guarantees
that root can always read, replace and delete a bucket policy even when the policy denies it.

```sh
aws s3api get-bucket-policy --bucket <bucket> --query Policy --output text > /tmp/policy.json
aws s3api delete-bucket-policy --bucket <bucket>
# ... the delete, or the reconfiguration, that the policy was refusing ...
aws s3api put-bucket-policy --bucket <bucket> --policy file:///tmp/policy.json
pnpm check:stack                                  # confirms the policy is back
```

A stuck state lock is `terraform -chdir=infra force-unlock <lock id>`. A bad apply is
recoverable because `bootstrap.sh` versions the state bucket:
`aws s3api list-object-versions --bucket <state bucket> --prefix hex-docs/infra.tfstate`.

Orphaned multipart parts, if anything ever starts an upload it cannot finish, are listed with
`aws s3api list-multipart-uploads` and removed with `aws s3api abort-multipart-upload`.
Neither is denied by the policy, and the lifecycle rule removes them after seven days anyway.

The bucket and the OIDC provider carry `prevent_destroy`, so `terraform destroy` fails at plan
and removing either one is a deliberate edit to `bucket.tf` or `oidc.tf`.

## The migration off the account root user

The deploy identity in this estate is the AWS account root user with a long-lived access key.
`providers.tf` warns about it on every plan, and it is the largest weakness this stack sits on
top of: root cannot be scoped by any policy here, and every apply is attributed to the account
rather than to a person.

1. Create an IAM Identity Center user, or one IAM user with MFA.
2. Create the deploy role by hand. This stack cannot create the role that applies it.
3. Point a profile at it and confirm: `aws sts get-caller-identity --query Arn --output text`
   must not end in `:root`.
4. Attach `terraform output -raw reader_policy_json` to whatever runs `hexdocs prefetch`.
5. Delete the root access key.

The `check` block in `providers.tf` goes quiet on its own at step 3. There is no flag to
remember to flip.

## What this does not close

Stated because a control list that only says what it stops is how the gaps get forgotten.

- **The root key.** Whoever holds it can `delete-bucket-policy` and then do as they like.
  An Organizations resource control policy would stop that, and there is no Organisation.
  What remains is that the removal is a named, CloudTrail-recorded management event rather
  than a side effect of an `aws s3 rm`.
- **Anyone who can push to the pinned branch of a publishing repository.** They can publish a
  bundle at that commit. They cannot overwrite an existing one, delete anything, or reach
  another project's prefix. The ceiling is a bundle at a sha nobody has labelled, which no
  site serves, plus that sha's publish address occupied for good: write-once then refuses the
  legitimate publish at the same address forever, so the recovery is the next commit rather
  than the root ritual above.
- **A compromised action inside any workflow on that branch.** The trust policy names no
  event, so any run on the pinned branch holding `id-token: write` satisfies it, whatever
  triggered it. `job_workflow_ref` would narrow that and is deliberately absent;
  `publishers.tf` carries the reasoning and what would change it.
- **A bad bundle already published.** The answer is that it is never labelled, not that it is
  deleted. Removing one is the recovery above.
- **This bucket as a log target.** The write-once deny has no service-principal exemption, so
  server access logging, CloudTrail delivery and load balancer logs all fail with a 403. All
  three authorise as `s3:PutObject` and none can carry an If-None-Match header. That is
  deliberate; they belong in a different bucket.
- **Replication, which is a separate case and not that one.** A replication write authorises
  as `s3:ReplicateObject`, not `s3:PutObject`, so the write-once deny never evaluates it.
  Until `DenyReplicationIntoStore` was added, a same-account replication rule naming this
  bucket as its destination succeeded: measured, `s3:ReplicateObject`, `s3:ReplicateDelete`
  and `s3:ReplicateTags` all returned allowed against the applied policy. A cross-account rule
  failed even then, but for the opposite reason to the one this list used to give: not because
  a deny reached it, but because the policy carries no Allow and a cross-account write needs
  one.
