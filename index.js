/**
 * GET /elections/{electionId}/candidates
 *
 * Lists all candidates/options registered for a given election, plus the
 * election's metadata (title, window, status) so the frontend can render
 * a ballot in one round trip.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
} = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const CANDIDATES_TABLE = process.env.CANDIDATES_TABLE;
const ELECTION_CONFIG_TABLE = process.env.ELECTION_CONFIG_TABLE;

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
    const electionId = event.pathParameters?.electionId;
    if (!electionId) {
      return response(400, { message: 'electionId path parameter is required' });
    }

    const [electionResult, candidatesResult] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: ELECTION_CONFIG_TABLE,
          Key: { electionId },
        })
      ),
      ddb.send(
        new QueryCommand({
          TableName: CANDIDATES_TABLE,
          KeyConditionExpression: 'electionId = :eid',
          ExpressionAttributeValues: { ':eid': electionId },
        })
      ),
    ]);

    if (!electionResult.Item) {
      return response(404, { message: 'Election not found' });
    }

    return response(200, {
      election: electionResult.Item,
      candidates: candidatesResult.Items || [],
    });
  } catch (err) {
    console.error('ListCandidates error:', err);
    return response(500, { message: 'Internal server error' });
  }
};
