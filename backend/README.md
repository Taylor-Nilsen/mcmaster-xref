# Backend: AWS Lambda (Always Free tier)

Renders the live McMaster page with real headless Chrome on every
request -- no caching. Runs on AWS Lambda because it's the only major
serverless platform with a genuinely permanent free tier (not a 12-month
trial) generous enough for headless Chrome: **1,000,000 requests/month +
400,000 GB-seconds of compute/month, forever**. At 1536 MB memory that's
roughly 260,000 seconds (~72 hours) of render time free every month --
far more than a personal cross-reference tool needs.

## 1. Package it

```
cd backend
npm install
zip -r function.zip index.js node_modules
```

(No `zip` command on Windows: use WSL, or 7-Zip's "add to archive"
targeting the same two paths.)

`@sparticuz/chromium`'s bundled Chromium binary is large -- if
`function.zip` comes out over 50 MB, the Lambda console's direct upload
will refuse it. Upload via S3 instead:

```
aws s3 cp function.zip s3://<a-bucket-you-own>/function.zip
```

then point Lambda at that S3 object instead of uploading the zip
directly (see step 2).

## 2. Create the Lambda function

In the [Lambda console](https://console.aws.amazon.com/lambda/), **Create
function**:

- Runtime: **Node.js 20.x**
- Architecture: **x86_64**
- Under **Code source**, upload `function.zip` (or, if it's over 50 MB,
  choose "Upload a file from Amazon S3" and paste the S3 URL from step 1)
- **Configuration → General configuration → Edit**: Memory **1536 MB**,
  Timeout **30 sec**

## 3. Turn on a public URL

**Configuration → Function URL → Create function URL**:

- Auth type: **NONE** (public -- this endpoint doesn't touch anything
  sensitive; it only reads a public McMaster page)
- Cross-origin resource sharing (CORS): enable it, set:
  - Allow origin: `*`
  - Allow methods: `POST`
  - Allow headers: `content-type`

Copy the Function URL it gives you (looks like
`https://xxxxxxxxxxxx.lambda-url.us-east-1.on.aws/`).

## 4. Point the frontend at it

Edit `frontend/config.js`:

```js
const BACKEND_URL = "https://xxxxxxxxxxxx.lambda-url.us-east-1.on.aws/";
```

Commit that change (see main [README](../README.md) for the GitHub Pages
step).

## Notes

- **Cold starts**: a Lambda that hasn't run in a while takes a few extra
  seconds to launch Chromium on the first request after idling. Expected
  and free -- there's nothing to fix here.
- **Redeploying after code changes**: repeat step 1, then in the Lambda
  console, **Code → Upload from** (.zip file or Amazon S3 location) with
  the new `function.zip`.
- **Local testing**: `node -e "require('./index.js').handler({requestContext:{http:{method:'POST'}}, body: JSON.stringify({partNumber:'91251A540'})}).then(r=>console.log(r))"` runs the handler directly, but launching Chromium needs the Lambda-provided binary paths/libs, so a real local dry run needs `npm i puppeteer` (full Puppeteer, with its own bundled Chromium) temporarily swapped in -- not worth setting up for a low-traffic personal tool; just deploy and test against the real function URL.
