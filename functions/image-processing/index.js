// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const Sharp = require("sharp");

const s3Client = new S3Client();
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);

// Lenslyst: gallery photo originals are moving to Cloudflare R2 (lens_server lib/photoStore), so
// they're read from there too (see fetchOriginal for the order); branding and video thumbnails stay on S3. The R2 read-only
// credentials are a SecureString SSM parameter (JSON: accountId, accessKeyId, secretAccessKey,
// buckets) named by r2ConfigParameter, read once per container. Without it, only S3 is read.
// `buckets` lists every environment's bucket (this one distribution serves production and
// development, like the S3 primary/secondary pair); keys never repeat across them.
const R2_CONFIG_PARAMETER = process.env.r2ConfigParameter;
const GALLERY_PHOTO_KEY = /^workspaces\/[^/]+\/galleries\/[^/]+\/files\//;
let r2Source = null; // Promise<{ client, buckets }>

function getR2Source() {
  if (!R2_CONFIG_PARAMETER) return null;
  r2Source ??= new SSMClient({})
    .send(new GetParameterCommand({ Name: R2_CONFIG_PARAMETER, WithDecryption: true }))
    .then((res) => {
      const config = JSON.parse(res.Parameter.Value);
      const buckets = config.buckets ?? (config.bucket ? [config.bucket] : []);
      if (!buckets.length) throw new Error(`${R2_CONFIG_PARAMETER} names no R2 buckets`);
      return {
        buckets,
        client: new S3Client({
          region: "auto",
          endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
          // R2 doesn't support all of the SDK's default checksums
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
        }),
      };
    })
    .catch((err) => {
      r2Source = null; // try again on the next request rather than staying broken
      throw err;
    });
  return r2Source;
}

const isNotFound = (err) => err && (err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata?.httpStatusCode === 404);

// Where to look for an original, in order. Gallery photos with today's keys: R2 first (most are
// there), then S3. Everything else — branding, video thumbnails, and gallery photos uploaded before
// mid-2025 under older keys (photos/..., photos/collections/...), which move to R2 too — S3 first,
// then R2. Resolves { body, contentType, source }, or null when none of them has it.
async function fetchOriginal(key) {
  const r2Sources = [];
  if (R2_CONFIG_PARAMETER) {
    // One source per R2 bucket; the credentials are read (once) when the first is tried
    const r2 = await getR2Source().catch((err) => err);
    if (r2 instanceof Error) r2Sources.push({ name: "R2", get: async () => { throw r2; } });
    else for (const bucket of r2.buckets) r2Sources.push({ name: `R2 ${bucket}`, get: async () => ({ client: r2.client, bucket }) });
  }
  const s3Sources = [{ name: "S3", get: async () => ({ client: s3Client, bucket: S3_ORIGINAL_IMAGE_BUCKET }) }];
  if (process.env.secondaryBucketName) {
    s3Sources.push({ name: "secondary S3", get: async () => ({ client: s3Client, bucket: process.env.secondaryBucketName }) });
  }
  const sources = GALLERY_PHOTO_KEY.test(key) ? [...r2Sources, ...s3Sources] : [...s3Sources, ...r2Sources];

  let unavailable = null; // a store we couldn't ask — "not found" would then be a guess
  for (const source of sources) {
    try {
      const { client, bucket } = await source.get();
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      console.log(`Got ${key} from ${source.name}`);
      return { body: out.Body.transformToByteArray(), contentType: out.ContentType, source: source.name };
    } catch (err) {
      if (isNotFound(err)) continue;
      console.log(`Couldn't read ${key} from ${source.name}`, err);
      unavailable = err;
    }
  }
  if (unavailable) throw unavailable;
  return null;
}

exports.handler = async (event) => {
  // Validate if this is a GET request
  if (
    !event.requestContext ||
    !event.requestContext.http ||
    !(event.requestContext.http.method === "GET")
  )
    return sendError(400, "Only GET method is supported", event);
  // An example of expected path is /images/rio/1.jpeg/format=auto,width=100 or /images/rio/1.jpeg/original where /images/rio/1.jpeg is the path of the original image
  var imagePathArray = event.requestContext.http.path.split("/");
  // get the requested image operations
  var operationsPrefix = imagePathArray.pop();
  // get the original image path images/rio/1.jpg
  imagePathArray.shift();
  var originalImagePath = imagePathArray.join("/");

  var startTime = performance.now();
  // Downloading original image
  let originalImageBody;
  let contentType;
  try {
    const original = await fetchOriginal(originalImagePath);
    if (!original) return sendError(404, "The requested image does not exist", originalImagePath);
    originalImageBody = original.body;
    contentType = original.contentType;
  } catch (error) {
    return sendError(500, "Error downloading original image", error);
  }
  let transformedImage = Sharp(await originalImageBody, {
    failOn: "none",
    animated: true,
  });
  // Get image orientation to rotate if needed
  const imageMetadata = await transformedImage.metadata();
  // execute the requested operations
  const operationsJSON = Object.fromEntries(
    operationsPrefix.split(",").map((operation) => operation.split("="))
  );
  // variable holding the server timing header value
  var timingLog = "img-download;dur=" + parseInt(performance.now() - startTime);
  startTime = performance.now();
  try {
    // check if resizing is requested
    var resizingOptions = {};
    if (operationsJSON["width"])
      resizingOptions.width = parseInt(operationsJSON["width"]);
    if (operationsJSON["height"])
      resizingOptions.height = parseInt(operationsJSON["height"]);
    if (resizingOptions)
      transformedImage = transformedImage.resize(resizingOptions);
    // check if rotation is needed
    if (imageMetadata.orientation) transformedImage = transformedImage.rotate();
    // check if formatting is requested
    if (operationsJSON["format"]) {
      var isLossy = false;
      switch (operationsJSON["format"]) {
        case "jpeg":
          contentType = "image/jpeg";
          isLossy = true;
          break;
        case "gif":
          contentType = "image/gif";
          break;
        case "webp":
          contentType = "image/webp";
          isLossy = true;
          break;
        case "png":
          contentType = "image/png";
          break;
        case "avif":
          contentType = "image/avif";
          isLossy = true;
          break;
        default:
          contentType = "image/jpeg";
          isLossy = true;
      }
      if (operationsJSON["quality"] && isLossy) {
        transformedImage = transformedImage.toFormat(operationsJSON["format"], {
          quality: parseInt(operationsJSON["quality"]),
        });
      } else
        transformedImage = transformedImage.toFormat(operationsJSON["format"]);
    } else {
      /// If not format is precised, Sharp converts svg to png by default https://github.com/aws-samples/image-optimization/issues/48
      if (contentType === "image/svg+xml") contentType = "image/png";
    }
    transformedImage = await transformedImage.toBuffer();
  } catch (error) {
    return sendError(500, "error transforming image", error);
  }
  timingLog =
    timingLog + ",img-transform;dur=" + parseInt(performance.now() - startTime);

  // handle gracefully generated images bigger than a specified limit (e.g. Lambda output object limit)
  const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

  // upload transformed image back to S3 if required in the architecture
  if (S3_TRANSFORMED_IMAGE_BUCKET) {
    startTime = performance.now();
    try {
      const putImageCommand = new PutObjectCommand({
        Body: transformedImage,
        Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
        Key: originalImagePath + "/" + operationsPrefix,
        ContentType: contentType,
        CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
      });
      await s3Client.send(putImageCommand);
      timingLog =
        timingLog +
        ",img-upload;dur=" +
        parseInt(performance.now() - startTime);
      // If the generated image file is too big, send a redirection to the generated image on S3, instead of serving it synchronously from Lambda.
      if (imageTooBig) {
        return {
          statusCode: 302,
          headers: {
            Location:
              "/" +
              originalImagePath +
              "?" +
              operationsPrefix.replace(/,/g, "&"),
            "Cache-Control": "private,no-store",
            "Server-Timing": timingLog,
          },
        };
      }
    } catch (error) {
      logError("Could not upload transformed image to S3", error);
    }
  }

  // Return error if the image is too big and a redirection to the generated image was not possible, else return transformed image
  if (imageTooBig) {
    return sendError(403, "Requested transformed image is too big", "");
  } else
    return {
      statusCode: 200,
      body: transformedImage.toString("base64"),
      isBase64Encoded: true,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": TRANSFORMED_IMAGE_CACHE_TTL,
        "Server-Timing": timingLog,
      },
    };
};

function sendError(statusCode, body, error) {
  logError(body, error);
  return { statusCode, body };
}

function logError(body, error) {
  console.log("APPLICATION ERROR", body);
  console.log(error);
}
