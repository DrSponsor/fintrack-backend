# Test data in this repository is invented

Every name, account number, bank reference and amount that appears in this
codebase — in tests, fixtures, comments, seed scripts and commit messages — is
made up. None of it belongs to a real person, and none of it came from a real
account.

## The names

They follow the legal placeholder convention, so they cannot be mistaken for
anybody:

| Name | Stands for |
|---|---|
| `JOHN ADEBAYO DOE` | the account holder |
| `MARY OKAFOR ROE` | a counterparty in a transfer |

The multi-word uppercase shape is deliberate — it is how Nigerian bank alerts
actually print a name, and parsing depends on that shape. The *values* are
fictional; only the **structure** is real.

## The numbers

| Value | Stands for |
|---|---|
| `012******345` | an account number, masked the way a bank masks it |
| `312ABCD2600000AA` | a bank's own transaction reference |
| `0123452345` | an account number a bank printed in full |

## Why this file exists

An earlier version of this repository did contain real data: a live account
holder's name, their account number, genuine amounts, real references, and the
full names of third parties on the other side of each transfer. Those people
never agreed to appear in a repository and had no way to ask for removal.

It was removed from the working tree and later from the entire git history
before anything was published. This file is here so that nobody encountering
`JOHN ADEBAYO DOE` in a test later mistakes it for someone's actual name, and
so the rule is written down rather than assumed:

**Never commit real financial data.** Parsing correctness depends on the shape
of a document — its labels, their order, the date format — and never on whose
money it describes. There is nothing to gain by using the real thing.
