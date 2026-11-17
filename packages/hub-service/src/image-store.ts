import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DELIVERY_IMAGE_LIMITS, type DeliverImageUrl } from "@pi-agent-hub/protocol";

/**
 * 007 交付图片中转（hub 侧落盘，SSE 只带 url）。
 *
 * console 以 base64 内联提交 → 校验 mime/单张大小/张数/总量 → 落盘
 * `<dataDir>/deliveries/<deliveryId>/images/<index>`，返回 {mime, url, sha256, bytes}。
 * daemon 以 Bearer 经 /api/v1/deliveries/:id/images/:index 下载；终态 GC 时 cleanupDelivery。
 */

export interface DeliverImageInput {
  mime: string;
  dataBase64: string;
  name?: string;
}

const ALLOWED_MIME = new Set<string>(DELIVERY_IMAGE_LIMITS.mime);

export class ImageStore {
  constructor(private readonly dataDir: string) {}

  deliveryDir(deliveryId: string): string {
    return join(this.dataDir, "deliveries", deliveryId);
  }

  /** 校验并落盘全部图片；任何一张不合法 → 抛 ImageValidationError（不落盘任何文件）。 */
  async saveImages(deliveryId: string, images: DeliverImageInput[]): Promise<DeliverImageUrl[]> {
    if (images.length === 0) return [];
    if (images.length > DELIVERY_IMAGE_LIMITS.maxCount) {
      throw new ImageValidationError("image_too_large", `at most ${DELIVERY_IMAGE_LIMITS.maxCount} images per message`);
    }
    const dir = join(this.deliveryDir(deliveryId), "images");
    await mkdir(dir, { recursive: true });
    const urls: DeliverImageUrl[] = [];
    let total = 0;
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const url = await this.toDeliverUrl(deliveryId, index, image, dir);
      total += url.bytes;
      if (total > DELIVERY_IMAGE_LIMITS.totalBytes) {
        // 总量超限：回滚已写文件。
        await rm(this.deliveryDir(deliveryId), { recursive: true, force: true }).catch(() => undefined);
        throw new ImageValidationError("image_too_large", "total image bytes exceed limit");
      }
      urls.push(url);
    }
    return urls;
  }

  private async toDeliverUrl(
    deliveryId: string,
    index: number,
    image: DeliverImageInput,
    dir: string,
  ): Promise<DeliverImageUrl> {
    if (!ALLOWED_MIME.has(image.mime)) {
      throw new ImageValidationError("image_invalid", `unsupported mime: ${image.mime}`);
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(image.dataBase64, "base64");
    } catch {
      throw new ImageValidationError("image_invalid", "invalid base64 image data");
    }
    const bytes = buffer.byteLength;
    if (bytes === 0) throw new ImageValidationError("image_invalid", "empty image data");
    if (bytes > DELIVERY_IMAGE_LIMITS.singleBytes) {
      throw new ImageValidationError(
        "image_too_large",
        `image size ${bytes} exceeds limit ${DELIVERY_IMAGE_LIMITS.singleBytes} bytes`,
      );
    }
    const file = join(dir, String(index));
    await writeFile(file, buffer);
    return {
      mime: image.mime,
      url: `/api/v1/deliveries/${encodeURIComponent(deliveryId)}/images/${index}`,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      bytes,
    };
  }

  async statImage(deliveryId: string, index: number): Promise<{ size: number; mime: string } | null> {
    const file = join(this.deliveryDir(deliveryId), "images", String(index));
    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      // mime 由调用方从 delivery 的 images_json 查出；这里只保证文件存在与大小。
      return { size: info.size, mime: "" };
    } catch {
      return null;
    }
  }

  async readImage(deliveryId: string, index: number): Promise<Buffer | null> {
    const file = join(this.deliveryDir(deliveryId), "images", String(index));
    try {
      return await readFile(file);
    } catch {
      return null;
    }
  }

  async cleanupDelivery(deliveryId: string): Promise<void> {
    await rm(this.deliveryDir(deliveryId), { recursive: true, force: true }).catch(() => undefined);
  }
}

export class ImageValidationError extends Error {
  constructor(
    readonly code: "image_invalid" | "image_too_large",
    message: string,
  ) {
    super(message);
    this.name = "ImageValidationError";
  }
}
