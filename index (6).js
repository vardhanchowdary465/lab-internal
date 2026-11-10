/**
 * POST /votes
 *
 * Casts exactly one vote per authenticated voter, per election.
 *
 * Design notes:
 * - "One voter one vote" is enforced with a DynamoDB TransactWriteItems call:
 *     1) Put a "ballot receipt" item with a ConditionExpression that fails
 *        if it already exists (attribute_not_exists(pk)).
 *     2) Atomically increment the candidate's vote counter (UpdateItem ADD).
 *   Both writes succeed or both fail -- there is no window where a double
 *   vote can sneak in, even under concurrent requests.
 * - The ballot receipt stores WHO voted (to block re-voting) but is kept in
 *   a separate logical record from WHAT they voted for is only reflected in
 *   the aggregate counter, not tied back to the voter -- preserving secrecy
 *   of ballot while preventing double-voting.
 * - electionId must be currently open (checked against ElectionConfig).
 */

const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const VOTES_TABLE = process.env.VOTES_TABLE;
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
    const claims = event.requestContext?.authorizer?.claims || event.requestContext?.authorizer?.jwt?.claims;
    const voterId = claims?.sub;

    if (!voterId) {
      return response(401, { message: 'Unauthorized: missing voter identity' });
    }

    const body = JSON.parse(event.body || '{}');
    const { electionId, candidateId } = body;

    if (!electionId || !candidateId) {
      return response(400, { message: 'electionId and candidateId are required' });
    }

    // 1. Confirm the election exists and is open
    const electionResult = await ddb.send(
      new GetCommand({
        TableName: ELECTION_CONFIG_TABLE,
        Key: { electionId },
      })
    );

    const election = electionResult.Item;
    if (!election) {
      return response(404, { message: 'Election not found' });
    }

    const now = new Date().toISOString();
    if (election.status !== 'OPEN' || now < election.startTime || now > election.endTime) {
      return response(403, { message: 'Voting is not currently open for this election' });
    }

    // 2. Confirm the candidate exists in this election
    const candidateResult = await ddb.send(
      new GetCommand({
        TableName: CANDIDATES_TABLE,
        Key: { electionId, candidateId },
      })
    );

    if (!candidateResult.Item) {
      return response(404, { message: 'Candidate not found in this election' });
    }

    // 3. Transactionally: (a) write a receipt that blocks double voting,
    //    (b) increment the candidate's atomic vote counter.
    const receiptKey = {
      pk: `VOTER#${voterId}`,
      sk: `ELECTION#${electionId}`,
    };

    const counterKey = {
      pk: `ELECTION#${electionId}`,
      sk: `CANDIDATE#${candidateId}`,
    };

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: VOTES_TABLE,
              Item: {
                ...receiptKey,
                votedAt: now,
                type: 'BALLOT_RECEIPT',
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: VOTES_TABLE,
              Key: counterKey,
              UpdateExpression:
                'SET voteCount = if_not_exists(voteCount, :zero) + :inc, candidateName = :name, #t = :type',
              ExpressionAttributeNames: { '#t': 'type' },
              ExpressionAttributeValues: {
                ':zero': 0,
                ':inc': 1,
                ':name': candidateResult.Item.name,
                ':type': 'TALLY',
              },
            },
          },
        ],
      })
    );

    return response(201, {
      message: 'Vote successfully cast',
      electionId,
      votedAt: now,
    });
  } catch (err) {
    if (err.name === 'TransactionCanceledException') {
      return response(409, {
        message: 'You have already voted in this election',
      });
    }
    console.error('CastVote error:', err);
    return response(500, { message: 'Internal server error' });
  }
};
