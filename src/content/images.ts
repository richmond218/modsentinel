/** Most images sent per post. Each costs roughly 1-1.5k input tokens. */
export const MAX_IMAGES = 4;

const IMAGE_EXTENSION = /\.(jpe?g|png|gif|webp)(\?|#|$)/i;

/** The post fields that can carry images, from either the trigger event or the Post model. */
export interface PostMediaFields {
  url?: string | undefined;
  isImage?: boolean | undefined;
  galleryImages?: string[] | undefined;
  mediaUrls?: string[] | undefined;
}

/**
 * Collect the image URLs worth showing the classifier for a post: the image
 * itself for image posts, each gallery image, and direct links to image
 * files. Reddit escapes `&` in media URLs, which breaks signed preview links,
 * so that is undone here. Capped at {@link MAX_IMAGES}.
 */
export function extractImageUrls(post: PostMediaFields): string[] {
  const candidates = [
    ...(post.isImage && post.url ? [post.url] : []),
    ...(post.galleryImages ?? []),
    ...(post.mediaUrls ?? []).filter((u) => IMAGE_EXTENSION.test(u)),
    ...(post.url && IMAGE_EXTENSION.test(post.url) ? [post.url] : []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const url = raw.replace(/&amp;/g, "&").trim();
    if (!/^https:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}
