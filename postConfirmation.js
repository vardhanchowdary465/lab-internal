/**
 * Cognito Post Confirmation Lambda Trigger
 *
 * Fires automatically right after a new user verifies their email address
 * in Cognito. Creates a minimal voter record in DynamoDB so the voter
 * "exists" in the system immediately, even before they fill in the full
 * profile via POST /voters/register.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const VOTERS_TABLE = process.env.VOTERS_TABLE;

exports.handler = async (event) => {
  try {
    const { sub, email } = event.request.userAttributes;

    await ddb.send(
      new PutCommand({
        TableName: VOTERS_TABLE,
        Item: {
          voterId: sub,
          email,
          registeredAt: new Date().toISOString(),
          profileComplete: false,
          eligible: true,
        },
        ConditionExpression: 'attribute_not_exists(voterId)',
      })
    );
  } catch (err) {
    // Don't block the Cognito sign-up flow if this fails -- log and move on.
    // The voter can still complete their profile via /voters/register later.
    console.error('PostConfirmation trigger error:', err);
  }

  return event;
};
