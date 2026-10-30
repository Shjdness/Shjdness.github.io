import type {D1Database} from '@cloudflare/workers-types';

// Capture the immediately preceding post INSERT's rowid once. Materialization
// prevents relation INSERTs from changing the ID used for subsequent tag rows.
export const NEW_POST_TAGS_SQL=`WITH new_feed AS MATERIALIZED (SELECT last_insert_rowid() AS id)
  INSERT INTO feed_hashtags(feed_id,hashtag_id)
  SELECT new_feed.id,CAST(tags.value AS INTEGER) FROM new_feed CROSS JOIN json_each(?) AS tags`;

/** The insert is generated and parameterized by Drizzle, including RETURNING id.
 * No query or vocabulary write may be inserted between these batch statements. */
export async function createPostWithTags(db:D1Database,insert:{sql:string;params:unknown[]},tagIds:number[]) {
  const statements=[db.prepare(insert.sql).bind(...insert.params)];
  if(tagIds.length)statements.push(db.prepare(NEW_POST_TAGS_SQL).bind(JSON.stringify(tagIds)));
  const [result]=await db.batch<{id:number}>(statements);
  const id=result.results?.[0]?.id;
  if(!Number.isSafeInteger(id)||id<=0)throw Error('Post creation was not acknowledged');
  return {insertedId:id};
}
