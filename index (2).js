/**
 * POST /voters/register
 *
 * Called by the frontend right after a voter's email is verified via
 * Cognito. Cognito handles credential storage and verification; this
 * endpoint persists additional voter profile data (name, registration
 * timestamp, eligibility flags) into DynamoDB. Idempotent: re-calling
 * it just overwrites the same profile record.
 *
 * Note: a Cognito Post Confirmation trigger (see ../auth/postConfirmation.js)
 * also creates a bare voter record automatically. This endpoint lets the
 * voter fill in additional profile fields afterward.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const VOTERS_TABLE = process.env.VOTERS_TABLE;

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    const claims = event.requestContext?.authorizer?.claims || event.requestContext?.authorizer?.jwt?.claims;
    const voterId = claims?.sub;
    const email = claims?.email;

    if (!voterId) {
      return response(401, { message: 'Unauthorized: missing voter identity' });
    }

    const body = JSON.parse(event.body || '{}');
    const { fullName, dateOfBirth, address } = body;

    if (!fullName) {
      return response(400, { message: 'fullName is required' });
    }

    await ddb.send(
      new PutCommand({
        TableName: VOTERS_TABLE,
        Item: {
          voterId,
          email,
          fullName,
          dateOfBirth: dateOfBirth || null,
          address: address || null,
          registeredAt: new Date().toISOString(),
          eligible: true,
        },
      })
    );

    return response(201, { message: 'Voter profile registered successfully', voterId });
  } catch (err) {
    console.error('RegisterVoter error:', err);
    return response(500, { message: 'Internal server error' });
  }
};
