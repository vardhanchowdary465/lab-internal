# Architecture

## Overview

```
                         ┌─────────────────┐
                         │   CloudFront     │
                         │  (CDN, HTTPS)    │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │   S3 Bucket       │  ← static frontend
                         │  (HTML/CSS/JS)    │     (no servers, no build step)
                         └───────────────────┘

   Browser (frontend/js) ──── auth ────► Cognito User Pool
            │
            │ Bearer <ID token>
            ▼
   ┌──────────────────┐
   │   API Gateway     │  ← Cognito authorizer on every route
   │  (REST API)       │
   └────────┬───────────┘
            │
   ┌────────┼────────────┬─────────────────┬───────────────────┐
   ▼                     ▼                 ▼                   ▼
RegisterVoter        CastVote          GetResults       ListCandidates
 (Lambda)            (Lambda)           (Lambda)            (Lambda)
   │                     │                 │                   │
   ▼                     ▼                 ▼                   ▼
Voters table        Votes table       Votes table       Candidates table
                   (transactional)   (strongly consist.)  + ElectionConfig
```

A fifth Lambda, `PostConfirmationTrigger`, is wired directly to Cognito (not
API Gateway) and fires automatically right after a voter verifies their
email, auto-creating a bare voter record.

## Why this shape

**Everything is managed/serverless.** No EC2, no containers to patch, no
servers to scale. Lambda scales per-request; DynamoDB and API Gateway scale
automatically; S3+CloudFront serve the frontend with no origin server at all.

**Auth is offloaded to Cognito**, not hand-rolled. Cognito handles password
hashing, email verification codes, and JWT issuance/rotation. API Gateway's
built-in Cognito authorizer validates the JWT on every request *before* the
Lambda even runs, so application code never has to verify tokens itself.

## The "one voter, one vote" guarantee

This is the trickiest correctness property in any voting system, and it's
solved with a single DynamoDB `TransactWriteItems` call in `vote/index.js`:

1. **Put** a ballot receipt at `pk=VOTER#<id>, sk=ELECTION#<electionId>`,
   with `ConditionExpression: attribute_not_exists(pk)`.
2. **Update** (atomic increment) the candidate's running tally at
   `pk=ELECTION#<electionId>, sk=CANDIDATE#<candidateId>`.

Both writes are atomic as a unit. If two requests from the same voter race
each other, DynamoDB guarantees only one of the two `Put`s succeeds — the
loser's entire transaction (including its counter increment) is rolled back.
This holds under arbitrary concurrency without needing a lock, a queue, or a
read-then-write check (which would have a race condition).

## Ballot secrecy vs. double-vote prevention

The receipt item (`VOTER#<id>` partition) records *that* a voter voted, but
not *what* they voted for — that detail lives only in the aggregate counter
item (`ELECTION#<id> / CANDIDATE#<id>`), which has no reference back to the
voter. This means:
- The system can prove a given voter participated (for audit/turnout stats)
- Nobody can look up how a specific voter voted by querying the table

This is the same separation real paper ballot systems use: a poll book
records who voted, a separate ballot box holds anonymous votes.

## Real-time results without a tally job

Because votes are tallied via atomic counters at write-time (not aggregated
later by a batch job), `GET /elections/{id}/results` is just a `Query` over
one partition with `ConsistentRead: true`. There's no MapReduce step, no
cron job, no eventual-consistency lag — the count reflects every committed
vote at the moment of the read.

## Single-table tally pattern

`VotesTable` deliberately stores two different *kinds* of items
(`BALLOT_RECEIPT` and `TALLY`) in the same table, distinguished by a `type`
attribute and key prefixes (`VOTER#…` vs `ELECTION#…`). This is the DynamoDB
single-table design pattern: it keeps the one operation that must be atomic
(record-receipt + increment-tally) inside a single table, which is required
for `TransactWriteItems` to work — DynamoDB transactions can span multiple
tables, but keeping directly-related items in one table simplifies the
access patterns and keeps the whole voting operation in one logical unit.

## Election lifecycle

`ElectionConfigTable` holds `status` (`OPEN`/`CLOSED`) and a `startTime`/
`endTime` window per election. `CastVoteFunction` checks both before
accepting a vote, so closing an election (or scheduling one to open later)
is a single item update — no redeploy needed.

## Frontend: static files, not a SPA framework

The frontend is plain HTML/CSS/vanilla JS — no React/Vue/webpack build step.
This matches the project's "serverless" thesis end-to-end: the frontend
itself has no build infrastructure, just files that sync straight to S3 and
serve through CloudFront. Cognito auth is implemented with direct calls to
the Cognito Identity Provider HTTPS API (no Amplify SDK bundle needed).

## Security notes

- All API routes require a valid Cognito ID token (`AWS_IAM`-free, JWT-based)
- DynamoDB tables use server-side encryption (SSE) at rest
- S3 frontend bucket blocks all public access; CloudFront reaches it only
  via Origin Access Control (OAC), so the bucket itself is never public
- API Gateway has throttling configured (50 req/s steady, 100 burst) to
  blunt basic abuse/flooding
- CORS is currently open (`*`) for ease of local testing — restrict
  `AllowOrigin` in `template.yaml` to your actual frontend domain before
  using this for a real election
