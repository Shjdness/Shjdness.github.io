export const DIARY_TAG = '日记';

export type TaggedPost = {
  hashtags?: Array<{ id?: number; name: string }>;
  createdAt?: Date | string;
  title?: string | null;
};

export const isDiary = (post: TaggedPost) => post.hashtags?.some(tag => tag.name === DIARY_TAG) ?? false;
export const getDiaryPosts = <T extends TaggedPost>(posts: T[]) => posts.filter(isDiary);
export const getNormalPosts = <T extends TaggedPost>(posts: T[]) => posts.filter(post => !isDiary(post));

export function diaryTimestamp(post: TaggedPost) {
  const match = (post.title || '').match(/(20\d{2})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/);
  if (!match) return post.createdAt ? new Date(post.createdAt).getTime() : 0;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(parsed) ? parsed : (post.createdAt ? new Date(post.createdAt).getTime() : 0);
}
