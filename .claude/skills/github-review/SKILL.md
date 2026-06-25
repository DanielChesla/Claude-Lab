---
name: github-review
description: Use this skill when reviewing GitHub repository state, commits, branches, issues, pull requests, or preparing GitHub-related recommendations.
---

# GitHub Review Skill

Use this skill when working with GitHub or reviewing a repository connected to GitHub.

## Rules

1. Start by checking the local Git status.
2. Identify the connected GitHub remote before using GitHub tools.
3. Clearly separate:
   - local Git state
   - remote GitHub state
   - MCP-reported GitHub data
4. Prefer read-only inspection unless the user explicitly asks for a write action.
5. Do not create branches, issues, pull requests, releases, tags, commits, or pushes unless explicitly instructed.
6. Before any GitHub write action, explain exactly what will change and ask for confirmation.
7. After review, summarize:
   - repository name
   - current branch
   - sync status
   - latest commits
   - open issues or pull requests if relevant
   - recommended next action

## Safe default behavior

When unsure, inspect only. Do not modify local files or GitHub.
