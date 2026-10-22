import { describe, it, expect } from "vitest";
import { extractImageUrls, MAX_IMAGES } from "../src/content/images.js";

describe("extractImageUrls", () => {
  it("uses the post url for image posts", () => {
    expect(extractImageUrls({ isImage: true, url: "https://i.redd.it/abc.jpg" })).toEqual(["https://i.redd.it/abc.jpg"]);
  });

  it("collects gallery images and unescapes &amp; in signed preview links", () => {
    expect(
      extractImageUrls({
        url: "https://www.reddit.com/gallery/xyz",
        galleryImages: [
          "https://preview.redd.it/a.png?width=640&amp;s=sig1",
          "https://preview.redd.it/b.png?width=640&amp;s=sig2",
        ],
      }),
    ).toEqual(["https://preview.redd.it/a.png?width=640&s=sig1", "https://preview.redd.it/b.png?width=640&s=sig2"]);
  });

  it("picks up direct image links but not ordinary links", () => {
    expect(extractImageUrls({ url: "https://i.imgur.com/x.webp" })).toEqual(["https://i.imgur.com/x.webp"]);
    expect(extractImageUrls({ url: "https://example.com/article" })).toEqual([]);
    expect(extractImageUrls({ mediaUrls: ["https://v.redd.it/video.mp4", "https://i.redd.it/c.gif"] })).toEqual([
      "https://i.redd.it/c.gif",
    ]);
  });

  it("dedupes, skips non-https, and caps the count", () => {
    const many = Array.from({ length: 10 }, (_, i) => `https://i.redd.it/${i}.png`);
    expect(extractImageUrls({ galleryImages: [...many, many[0]!] })).toHaveLength(MAX_IMAGES);
    expect(extractImageUrls({ isImage: true, url: "http://insecure.example/a.jpg" })).toEqual([]);
  });

  it("returns nothing for text posts", () => {
    expect(extractImageUrls({ url: "https://www.reddit.com/r/x/comments/1/t/" })).toEqual([]);
  });
});
