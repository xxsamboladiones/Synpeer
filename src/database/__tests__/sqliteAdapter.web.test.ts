import { AppError } from '@/errors/AppError';

import { openDatabaseService } from '../sqliteAdapter.web';

const insertPost = `
  INSERT OR REPLACE INTO posts
  (id, author, createdAt, updatedAt, signature, version, text, contentHash, mediaAttachments, replyTo, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const insertProfile = `
  INSERT OR REPLACE INTO profiles
  (id, author, createdAt, updatedAt, signature, version, username, displayName, bio, avatarHash, postCount, followerCount, followingCount)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const insertFollow = `
  INSERT OR REPLACE INTO follows
  (id, author, createdAt, updatedAt, signature, version, followerId, followingId, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const insertComment = `
  INSERT OR REPLACE INTO comments
  (id, author, createdAt, updatedAt, signature, version, postId, text, contentHash, parentCommentId, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const insertReaction = `
  INSERT OR REPLACE INTO reactions
  (id, author, createdAt, updatedAt, signature, version, postId, commentId, reactionType, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const insertChatMessage = `
  INSERT OR REPLACE INTO chat_messages
  (id, author, createdAt, updatedAt, signature, version, conversationId, senderId, recipientId, text, contentHash, deliveredAt, readAt, relayOnly, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

describe('sqliteAdapter.web', () => {
  it('uses explicit memory fallback capabilities when IndexedDB is unavailable in tests', async () => {
    const database = await openDatabaseService({ forceMemory: true });

    expect(database.getCapabilities()).toMatchObject({
      backend: 'memory',
      persistenceGuaranteed: false,
      transactions: true,
    });
  });

  it('writes, reads, updates, removes and resets rows through the web contract', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    await database.execute('CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY)');

    await database.run(insertPost, [
      'post-1',
      'alice',
      10,
      10,
      'sig',
      1,
      'hello',
      'hash-1',
      '[]',
      null,
      0,
    ]);

    expect(await database.query('SELECT * FROM posts WHERE id = ?', ['post-1'])).toMatchObject([
      { id: 'post-1', text: 'hello' },
    ]);

    await database.run(
      'UPDATE posts SET updatedAt = ?, signature = ?, version = ?, text = ?, contentHash = ?, mediaAttachments = ?, deleted = ? WHERE id = ?',
      [20, 'sig-2', 2, 'edited', 'hash-2', '[]', 0, 'post-1'],
    );

    expect(
      await database.query('SELECT * FROM posts WHERE contentHash = ?', ['hash-2']),
    ).toMatchObject([{ id: 'post-1', text: 'edited', version: 2 }]);

    await database.run('DELETE FROM posts WHERE id = ?', ['post-1']);
    expect(await database.query('SELECT * FROM posts WHERE id = ?', ['post-1'])).toEqual([]);

    await database.run(insertPost, [
      'post-2',
      'alice',
      10,
      10,
      'sig',
      1,
      'again',
      'hash-3',
      '[]',
      null,
      0,
    ]);
    await database.reset();
    expect(await database.query('SELECT * FROM posts')).toEqual([]);
  });

  it('throws a typed storage error after the fallback backend is closed', async () => {
    const database = await openDatabaseService({ forceMemory: true });

    await database.close();

    await expect(database.query('SELECT * FROM posts')).rejects.toBeInstanceOf(AppError);
  });

  it('persists profiles and follow counters through the web contract', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    await database.execute('CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY)');
    await database.execute('CREATE TABLE IF NOT EXISTS follows (id TEXT PRIMARY KEY)');

    await database.run(insertProfile, [
      'profile-peer-a',
      'peer-a',
      10,
      10,
      'sig',
      '1.0.0',
      'alice',
      'Alice',
      'hello',
      null,
      0,
      0,
      0,
    ]);

    expect(
      await database.query('SELECT * FROM profiles WHERE author = ?', ['peer-a']),
    ).toMatchObject([{ id: 'profile-peer-a', username: 'alice', displayName: 'Alice' }]);

    await database.run(
      'UPDATE profiles SET updatedAt = ?, signature = ?, version = ?, username = ?, displayName = ?, bio = ?, avatarHash = ?, postCount = ?, followerCount = ?, followingCount = ? WHERE id = ?',
      [20, 'sig-2', '1.0.1', 'alice_2', 'Alice 2', 'updated', null, 1, 2, 3, 'profile-peer-a'],
    );

    expect(
      await database.query('SELECT * FROM profiles WHERE username = ?', ['alice_2']),
    ).toMatchObject([{ displayName: 'Alice 2', bio: 'updated', followingCount: 3 }]);

    await database.run(insertFollow, [
      'follow-1',
      'peer-b',
      30,
      30,
      'sig',
      '1.0.0',
      'peer-b',
      'peer-a',
      0,
    ]);

    expect(
      await database.query(
        'SELECT COUNT(*) as count FROM follows WHERE followingId = ? AND deleted = 0',
        ['peer-a'],
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await database.query(
        'SELECT COUNT(*) as count FROM follows WHERE followerId = ? AND deleted = 0',
        ['peer-b'],
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('returns stable comment and reaction counts for feed queries', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    await database.execute('CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY)');
    await database.execute('CREATE TABLE IF NOT EXISTS reactions (id TEXT PRIMARY KEY)');

    expect(
      await database.query(
        'SELECT COUNT(*) as count FROM comments WHERE postId = ? AND deleted = 0',
        ['post-1'],
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await database.query(
        'SELECT COUNT(*) as count FROM reactions WHERE postId = ? AND deleted = 0',
        ['post-1'],
      ),
    ).toEqual([{ count: 0 }]);

    await database.run(insertComment, [
      'comment-1',
      'peer-a',
      10,
      10,
      'sig',
      '1.0.0',
      'post-1',
      'reply',
      'hash-comment',
      null,
      0,
    ]);
    await database.run(insertReaction, [
      'reaction-1',
      'peer-b',
      20,
      20,
      'sig',
      '1.0.0',
      'post-1',
      null,
      'like',
      0,
    ]);

    expect(
      await database.query('SELECT * FROM comments WHERE postId = ?', ['post-1']),
    ).toMatchObject([{ id: 'comment-1', text: 'reply' }]);
    expect(
      await database.query('SELECT * FROM reactions WHERE postId = ?', ['post-1']),
    ).toMatchObject([{ id: 'reaction-1', reactionType: 'like' }]);
    expect(
      await database.query(
        'SELECT COUNT(*) as count FROM comments WHERE postId = ? AND deleted = 0',
        ['post-1'],
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await database.query(
        'SELECT COUNT(*) as count FROM reactions WHERE postId = ? AND deleted = 0',
        ['post-1'],
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await database.query(
        'SELECT COUNT(*) as count FROM reactions WHERE author = ? AND postId = ? AND (commentId = ? OR (commentId IS NULL AND ? IS NULL)) AND deleted = 0',
        ['peer-b', 'post-1', null, null],
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('persists visible chat messages and hides relay-only messages in conversations', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    await database.execute('CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY)');

    await database.run(insertChatMessage, [
      'chat-visible',
      'peer-a',
      10,
      10,
      'sig',
      '1.0.0',
      'peer-a:peer-b',
      'peer-a',
      'peer-b',
      'hello',
      'hash-visible',
      null,
      null,
      0,
      0,
    ]);
    await database.run(insertChatMessage, [
      'chat-relay',
      'peer-c',
      20,
      20,
      'sig',
      '1.0.0',
      'peer-c:peer-d',
      'peer-c',
      'peer-d',
      'relay',
      'hash-relay',
      null,
      null,
      1,
      0,
    ]);

    expect(
      await database.query(
        'SELECT * FROM chat_messages WHERE conversationId = ? AND deleted = 0 AND relayOnly = 0 ORDER BY createdAt ASC LIMIT ? OFFSET ?',
        ['peer-a:peer-b', 100, 0],
      ),
    ).toMatchObject([{ id: 'chat-visible', text: 'hello' }]);
    expect(
      await database.query(
        'SELECT * FROM chat_messages WHERE conversationId = ? AND deleted = 0 AND relayOnly = 0 ORDER BY createdAt ASC LIMIT ? OFFSET ?',
        ['peer-c:peer-d', 100, 0],
      ),
    ).toEqual([]);
    expect(
      await database.query(
        'SELECT COUNT(*) as count FROM chat_messages WHERE deleted = 0 AND relayOnly = 0',
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await database.query('SELECT * FROM chat_messages WHERE contentHash = ?', ['hash-relay']),
    ).toMatchObject([{ id: 'chat-relay', relayOnly: 1 }]);
  });

  it('keeps tombstones available to anti-entropy queries while hiding them from UI queries', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    await database.run(insertPost, [
      'post-deleted',
      'peer-a',
      10,
      20,
      'sig-deleted',
      '1',
      'removed',
      'hash-deleted',
      '[]',
      null,
      1,
    ]);
    await database.run(insertComment, [
      'comment-deleted',
      'peer-a',
      10,
      20,
      'sig-deleted',
      '1',
      'post-deleted',
      'removed',
      'hash-comment-deleted',
      null,
      1,
    ]);
    await database.run(insertReaction, [
      'reaction-deleted',
      'peer-a',
      10,
      20,
      'sig-deleted',
      '1',
      'post-deleted',
      null,
      'like',
      1,
    ]);
    await database.run(insertFollow, [
      'follow-deleted',
      'peer-a',
      10,
      20,
      'sig-deleted',
      '1',
      'peer-a',
      'peer-b',
      1,
    ]);

    await expect(database.query('SELECT * FROM posts WHERE deleted = 0')).resolves.toEqual([]);
    await expect(
      database.query('SELECT * FROM posts WHERE deleted IN (0, 1) ORDER BY updatedAt ASC'),
    ).resolves.toHaveLength(1);
    await expect(
      database.query('SELECT * FROM comments WHERE deleted IN (0, 1) ORDER BY updatedAt ASC'),
    ).resolves.toHaveLength(1);
    await expect(
      database.query('SELECT * FROM reactions WHERE deleted IN (0, 1) ORDER BY updatedAt ASC'),
    ).resolves.toHaveLength(1);
    await expect(
      database.query('SELECT * FROM follows WHERE deleted IN (0, 1) ORDER BY updatedAt ASC'),
    ).resolves.toHaveLength(1);
  });
});
