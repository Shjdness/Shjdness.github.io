export type FeedPermissionContext = {
  ownerId: number;
  viewerId?: number;
  admin?: boolean;
  writer?: boolean;
  draft?: boolean | number;
  kind?: string;
};

export const isPrivateFeed = ({ draft, kind }: Pick<FeedPermissionContext, 'draft' | 'kind'>) =>
  Boolean(draft) || kind === 'diary' || kind === 'memo';

export const canReadFeed = (context: FeedPermissionContext) =>
  !isPrivateFeed(context) || Boolean(context.admin) || context.ownerId === context.viewerId;

export const canMutateFeed = (context: FeedPermissionContext) =>
  Boolean(context.admin) || Boolean(context.writer && context.viewerId && context.ownerId === context.viewerId);
