import { describe, expect, it } from 'vitest';
import { canMutateFeed, canReadFeed } from './feed-permissions';

describe('draft and private feed permissions', () => {
  it('keeps public posts readable', () => expect(canReadFeed({ ownerId: 1, viewerId: 2, draft: false, kind: 'article' })).toBe(true));
  it('lets an owner read and edit their own draft', () => {
    const context = { ownerId: 1, viewerId: 1, writer: true, draft: true };
    expect(canReadFeed(context)).toBe(true);
    expect(canMutateFeed(context)).toBe(true);
  });
  it('does not let a trusted writer read or edit another account draft', () => {
    const context = { ownerId: 1, viewerId: 2, writer: true, draft: true };
    expect(canReadFeed(context)).toBe(false);
    expect(canMutateFeed(context)).toBe(false);
  });
  it('lets an administrator maintain private content', () => {
    const context = { ownerId: 1, viewerId: 2, admin: true, draft: true };
    expect(canReadFeed(context)).toBe(true);
    expect(canMutateFeed(context)).toBe(true);
  });
});
