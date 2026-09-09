# Everything this stack has to be told.
#
# Nothing here carries a default that names the estate. This repository is public, and a
# default is the value nobody overrides and everybody stops reading. The region is the one
# exception, and it is one because a region names no account and grants nothing: hex-docs
# states ap-southeast-2 in public already.

variable "allowed_account_ids" {
  description = "The one account this stack may be applied to, as a single-element list. No default: the account id is the thing this public repository must never carry, and the provider refuses before reading anything if the ambient credentials resolve elsewhere."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.allowed_account_ids) == 1
    error_message = "allowed_account_ids must name exactly one account. A list of two is a stack that can be applied to the wrong one."
  }

  validation {
    condition     = alltrue([for id in var.allowed_account_ids : can(regex("^[0-9]{12}$", id))])
    error_message = "An AWS account id is twelve digits. A placeholder copied out of README.md fails here rather than at the first API call."
  }
}

variable "region" {
  description = "The region the bundle store lives in."
  type        = string
  default     = "ap-southeast-2"
  nullable    = false
}

variable "bucket_name" {
  description = "The bundle store's bucket name. No default: a default would be the one place the estate's bucket name is written into a public repository."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a valid S3 general purpose bucket name: 3 to 63 characters, lower case letters, digits, hyphens and dots, beginning and ending alphanumeric."
  }
}

variable "role_name_prefix" {
  description = "Prefix for each publisher role's name. The name carries no account id, so it is safe in public; the ARN it appears in is an output and is never committed. Changing it renames every publisher role, which replaces the role and changes its ARN, so the HEXDOCS_PUBLISH_ROLE variable in each publishing repository has to be reset afterwards. See infra/README.md."
  type        = string
  default     = "hexdocs-publisher"
  nullable    = false

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,48}$", var.role_name_prefix))
    error_message = "role_name_prefix must be IAM friendly and at most 48 characters, leaving room for the map key in the composed role name: letters, digits and +=,.@_- only."
  }
}

variable "publishers" {
  description = <<-EOT
    One entry per app repository allowed to publish bundles. The map key names the role
    suffix; everything else is what the trust policy pins. Renaming a key therefore renames
    the role, which replaces it and changes its ARN, so the HEXDOCS_PUBLISH_ROLE variable in
    that repository has to be reset afterwards. See infra/README.md.

    A second app repository is one entry, and that is the whole shape of the variable. The
    alternative, a role per repository written out by hand, is how two roles end up with
    different conditions and only one of them gets reviewed.

    `repository_id` is GitHub's immutable numeric id, from
    `gh api repos/<owner>/<repository> -q .id`. It is a string because IAM condition values
    are strings and a number here would render as one in the JSON and never match.

    `projects` lists the `<project>` prefixes this repository owns, matching the first
    segment `bundlePrefix()` writes in `src/contracts/manifest.ts`. The role can read and
    write nowhere else in the bucket.
  EOT

  type = map(object({
    owner         = string
    repository    = string
    repository_id = string
    branch        = optional(string, "main")
    projects      = list(string)
  }))
  nullable = false

  validation {
    condition     = length(var.publishers) > 0
    error_message = "publishers is empty, so this stack would create a bucket nothing can write to. That is not a smaller configuration, it is a store with no publisher."
  }

  validation {
    condition     = alltrue([for p in var.publishers : can(regex("^[0-9]{1,20}$", p.repository_id))])
    error_message = "Every repository_id must be GitHub's numeric repository id, as a string of digits. A name here would pin nothing: names are reclaimable and ids are not."
  }

  validation {
    # An empty owner or repository renders a subject pattern no GitHub token can ever match,
    # so every publish is denied with a message naming no claim. That, and not Access
    # Analyzer, is what this refuses: measured, the rendered trust policy with an empty owner
    # returns the same two advisory findings as a correct one and no ERROR.
    condition     = alltrue([for p in var.publishers : length(p.owner) >= 1 && length(p.repository) >= 1])
    error_message = "Every publisher needs a non-empty owner and repository. They are what pin the subject to one repository rather than to a whole organisation."
  }

  validation {
    # Four, and the number is Access Analyzer's rather than GitHub's. The rule is per
    # wildcard over the literal run immediately preceding it, and it wants six consecutive
    # characters. The immutable-subject pattern this stack writes,
    # `repo:<owner>@*/<repository>@*:ref:...`, has two wildcards: the first is preceded by
    # `repo:<owner>@`, which is six plus the owner's length and so can never fail, and the
    # second by `/<repository>@`, which is the repository's length plus two.
    #
    # Measured against `aws accessanalyzer validate-policy` on the rendered document:
    # repository names of one, two and three characters each return
    # WILDCARD_USAGE_TOO_PERMISSIVE, and four is clean. Without this, such a name plans
    # green and then fails `pnpm check:stack`'s policy validation row with an issue code and
    # a JSON path naming neither the repository nor its length.
    condition     = alltrue([for p in var.publishers : length(p.repository) >= 4])
    error_message = "Every publisher's repository name must be at least four characters. Access Analyzer wants six literal characters before each wildcard, and the immutable-subject pattern puts only `/<repository>@` before its second one, so a shorter name renders a policy that plans clean and fails pnpm check:stack as WILDCARD_USAGE_TOO_PERMISSIVE."
  }

  validation {
    # IAM's role name limit is 64 and the composed name is `${role_name_prefix}-${key}`, so
    # the two variables can each be legal on their own and illegal together. Checked here
    # rather than left to apply, because roles order after the bucket, the bucket policy and
    # the OIDC provider: an apply-time refusal leaves a half-applied stack and a state file
    # against a live account.
    condition     = alltrue([for k, _ in var.publishers : length("${var.role_name_prefix}-${k}") <= 64])
    error_message = "A publisher key composes a role name over IAM's 64 character limit with this role_name_prefix. The name is role_name_prefix, a hyphen, then the map key."
  }

  validation {
    # The branch is half of one OIDC claim and half of another. `refs/heads/<branch>` is
    # compared against `ref`, and the same string appears inside both subject patterns, so
    # a value carrying a slash or a `refs/` prefix produces a policy that matches nothing
    # and denies every publish with a message naming no claim.
    condition     = alltrue([for p in var.publishers : can(regex("^[A-Za-z0-9._-]+$", p.branch))])
    error_message = "Each branch must be a plain branch name such as main, not a ref path. The stack writes refs/heads/<branch> itself."
  }

  validation {
    condition     = alltrue([for p in var.publishers : length(p.projects) > 0])
    error_message = "Every publisher must own at least one project prefix, or its role can write nowhere and the repository's first publish fails on a permission nobody granted."
  }

  validation {
    condition     = alltrue([for p in var.publishers : alltrue([for s in p.projects : can(regex("^[a-z0-9]+(-[a-z0-9]+)*$", s))])])
    error_message = "Every project prefix must be a lower case kebab slug, matching PROJECT_ID_PATTERN and the first segment bundlePrefix() writes. A prefix carrying a slash would widen the role past one project."
  }

  validation {
    # Two repositories claiming one prefix is not a duplicate, it is a repository able to
    # write into another repository's bundles. Write-once makes that a refusal rather than
    # corruption, but the refusal lands in the wrong repository's CI and reads there as a
    # publish that inexplicably stopped working.
    condition     = length(distinct(flatten([for p in var.publishers : p.projects]))) == length(flatten([for p in var.publishers : p.projects]))
    error_message = "Two publishers claim the same project prefix. A project belongs to exactly one repository, or one repository's role can write into another's bundles."
  }
}

variable "tags" {
  description = "Extra tags merged into the provider's default_tags. Cost allocation and ownership belong here; nothing here is read by any policy."
  type        = map(string)
  default     = {}
  nullable    = false
}
