# Agent directive helper

This branch adds an agent directive Netlify function and a workflow gate that queries it before running heavy steps.

Files added:
- netlify/functions/agent-directive.mjs  (stores directives, principals, and nonces)
- .github/agent-directive.json (template/top-level directive file)

Usage notes are in README.md and in the function source.
