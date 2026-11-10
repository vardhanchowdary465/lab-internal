# Deployment Guide

This project deploys with the **AWS SAM CLI**. Everything — Lambda functions,
API Gateway, DynamoDB tables, Cognito, and the CloudFront+S3 frontend — is
defined in `template.yaml` and created in one `sam deploy`.

## Prerequisites

- AWS account with credentials configured (`aws configure`)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) installed
- Node.js 20.x
- An AWS region with Cognito + API Gateway + DynamoDB available (most regions)

## 1. Build

```bash
cd serverless-voting-system
sam build
```

This installs each Lambda function's `node_modules` (from its `package.json`)
and stages everything in `.aws-sam/build`.

## 2. Deploy the backend

```bash
sam deploy --guided
```

`--guided` walks you through stack name, region, and parameter values the
first time; it writes them into `samconfig.toml` so future deploys are just
`sam deploy`. Accept the IAM capability prompt (the stack creates roles for
each Lambda).

When it finishes, note the **Outputs** section — you'll need:

- `ApiEndpoint`
- `UserPoolId`
- `UserPoolClientId`
- `FrontendBucketName`
- `FrontendURL`

## 3. Seed sample election data

```bash
cd infrastructure
npm install
STAGE=dev AWS_REGION=us-east-1 node seed.js
```

This creates one open election (`election-2026-general`) with three sample
candidates so you can test end-to-end immediately. Adjust `STAGE`/`AWS_REGION`
to match what you deployed.

## 4. Configure the frontend

Edit `frontend/js/config.js` with the values from the stack Outputs:

```js
window.VOTING_CONFIG = {
  apiBaseUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/dev',
  cognito: {
    region: 'us-east-1',
    userPoolId: 'us-east-1_XXXXXXXXX',
    clientId: 'xxxxxxxxxxxxxxxxxxxxxxxxxx',
  },
  electionId: 'election-2026-general',
  resultsPollIntervalMs: 5000,
};
```

## 5. Upload the frontend to S3

```bash
aws s3 sync frontend/ s3://<FrontendBucketName> --exclude "*.md"
```

Then invalidate CloudFront so it picks up the new files immediately:

```bash
aws cloudfront create-invalidation \
  --distribution-id <YOUR_DISTRIBUTION_ID> \
  --paths "/*"
```

(Find the distribution ID with `aws cloudfront list-distributions`, or look
it up in the console under the domain shown in the `FrontendURL` output.)

## 6. Try it out

Open `FrontendURL` from the stack outputs. Register a voter, verify the email
code (Cognito sends this automatically), cast a vote, and watch the live
results view poll for updates.

## Running tests locally

```bash
cd backend
npm install
npm test
```

Tests mock the DynamoDB client (`aws-sdk-client-mock`) so they run with no
AWS credentials or network access — they validate the vote-casting Lambda's
logic: auth checks, election-window validation, successful vote casting, and
double-vote rejection via the DynamoDB transaction.

## Tearing down

```bash
sam delete
```

This removes the whole stack. Empty the S3 bucket first if `sam delete`
complains about a non-empty bucket (`aws s3 rm s3://<bucket> --recursive`).

## Cost notes

Every resource here is pay-per-use:
- DynamoDB tables use `PAY_PER_REQUEST` billing
- Lambda + API Gateway charge per invocation
- S3 + CloudFront charge per request/GB transferred

At hackathon/demo scale (a few hundred votes) this comfortably stays within
the AWS Free Tier.
