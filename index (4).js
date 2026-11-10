/**
 * GET /elections/{electionId}/results
 *
 * Returns real-time vote tallies by querying all TALLY items under
 * the election's partition key. Because vote counts are maintained via
 * atomic counters (see vote/index.js), this read is always consistent
 * with all committed votes and requires no aggregation/MapReduce step --
 * it's a single Query call, making "real-time" results genuinely cheap.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const VOTES_TABLE = process.env.VOTES_TABLE;

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

    const result = await ddb.send(
      new QueryCommand({
        TableName: VOTES_TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        FilterExpression: '#t = :tally',
        ExpressionAttributeNames: { '#t': 'type' },
        ExpressionAttributeValues: {
          ':pk': `ELECTION#${electionId}`,
          ':prefix': 'CANDIDATE#',
          ':tally': 'TALLY',
        },
        // Strongly consistent read so "real-time" actually means real-time,
        // not eventually-consistent-up-to-a-second-ago.
        ConsistentRead: true,
      })
    );

    const tallies = (result.Items || []).map((item) => ({
      candidateId: item.sk.replace('CANDIDATE#', ''),
      candidateName: item.candidateName,
      voteCount: item.voteCount || 0,
    }));

    tallies.sort((a, b) => b.voteCount - a.voteCount);

    const totalVotes = tallies.reduce((sum, t) => sum + t.voteCount, 0);

    return response(200, {
      electionId,
      totalVotes,
      results: tallies,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GetResults error:', err);
    return response(500, { message: 'Internal server error' });
  }
};
