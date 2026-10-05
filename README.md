# LittleSpaces

![LittleSpaces — Make your own apps. Just ask.](docs/assets/readme-banner.gif)

**Make your own apps. Just ask.**

Describe what you need. Build it with ChatGPT. Make it yours.

A plant journal, a reading tracker, that oddly specific tool you've always wanted. Create personal apps through conversation, use them from your own launcher, and keep changing them as your needs change. Runs on your own server, with one private workspace per owner.

## Get started

Requires Node.js 24+, npm, and macOS or Linux. On Linux, install Bubblewrap (`bwrap`) too.

```sh
npm ci
npm run dev
```

Open the private setup link printed in the terminal to create your account. Then connect ChatGPT in **Settings**, choose **Add new**, and describe your app. For local access, use `http://127.0.0.1:5173`.

## Docs

- [Self-hosting and VPS deployment](docs/self-hosting.md) — including remote ChatGPT setup.
- [Project reference](docs/project-reference.md) — features, limitations, customization, and development.
- [App backend API](docs/applet-backends.md) · [Diagnostics](docs/diagnostics.md)
