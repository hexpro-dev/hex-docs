# The stack's version floor, its provider pin, and where its state lives.

terraform {
  # 1.11 is where S3 native state locking (`use_lockfile`) went GA, which is what lets the
  # backend below drop the DynamoDB lock table the estate's older convention needs. The test
  # file's `override_during = plan` landed in the same release, so 1.11 is the technical
  # minimum: the stack itself uses nothing newer.
  #
  # The floor is 1.14 anyway, because that is what `.github/workflows/ci.yml` installs and
  # the only line this stack has ever been run on, so a local `pnpm check:infra` and a CI one
  # are the same run. Lowering it means measuring the versions in between rather than reading
  # their changelogs, which is the difference between a compatibility claim and a guess.
  required_version = ">= 1.14.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # The 5.x line is dead: its last release was 2025-06-12, six days before 6.0.0, and
      # nothing has shipped on it since. Pinned to the major and not to a patch, because
      # `.terraform.lock.hcl` is committed and is what actually fixes the version and its
      # hashes. A second exact pin here would be a number to bump in two places, and the
      # one somebody forgot would be this one.
      version = "~> 6.0"
    }
  }

  # Partial on purpose, and that is why this file names no bucket. The estate convention is
  # a state bucket per project, and this repository is public, so every backend value
  # arrives through `-backend-config` at init and `README.md` carries the command. A
  # filled-in backend block would be the one place the account's state location is written
  # down in public, and it would be in the file somebody copies to start the next stack.
  #
  # `use_lockfile` is here rather than in the init flags so that turning locking off is a
  # visible edit to a tracked file. Two concurrent applies without it interleave, and the
  # loser's resources become orphans the next plan wants to create again, which against a
  # write-once bucket is a refusal rather than a repair.
  backend "s3" {
    use_lockfile = true
  }
}
