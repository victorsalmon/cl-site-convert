# Runbook — plugin template

**Status: stub.** This is the scaffold for a plugin's operator runbook, not the
authoring guide. The full authoring runbook is bead **B4.4**
(`docs/runbooks/CREATING_NEW_PLUGINS.md`).

Copy this file to `plugins/<vendor>/runbook.md` and fill in each section for the
plugin you are actually shipping.

## 1. What this plugin does

One paragraph: which seam it sits on (source adapter, emitter, sink, deployer),
which capability of the source site it covers, and which artifact kinds it
emits.

## 2. Requirements and credentials

What the operator must provision before the plugin can run (account, API token,
secret name), how it is passed in (environment variable or config key), and
how to verify it is present **without printing the value**.

## 3. Running it

The exact command, the config file it reads, and the expected output path.

## 4. Verifying it worked

The gate that proves a run succeeded — not "it looked right". Name the test,
fixture, or artifact check.

## 5. Failure modes

What this plugin refuses to do, what error it raises, and what the operator
should do next. Unsupported source-site capability must fail loudly, never
degrade silently.
