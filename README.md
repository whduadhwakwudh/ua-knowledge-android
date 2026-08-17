# UA Android wrapper

This directory wraps the Open Design artifact as a local Capacitor Android app.

## Source ownership

- `www/index.html`: Android fullscreen derivative of the original Open Design artifact.
- Original OD artifact remains unchanged at `D:\open-design\.od\projects\ua-knowledge-base\ua-mobile-app.html`.
- App id: `io.ua.knowledgebase`.
- Minimum Android API: 24; target/compile API: 36.

## Rebuild

```powershell
& .\build-apk.ps1
```

The script uses:

- Temurin JDK 21: `D:\Java\jdk-21.0.12+8` (required by Capacitor 8)
- Android SDK: `D:\Android\Sdk`
- Capacitor web directory: `www`

Output: `dist\UA-debug.apk`.

This is a debug-signed WebView application for local testing and demonstrations. Publishing requires a private release keystore, release signing configuration, final app icon/splash assets, versioning, privacy review, and an AAB release build.
