# Releasing Wordsmith

## One-time setup

Mac updates only install if the app is signed with a Developer ID and notarised by Apple, so the Release
workflow refuses to publish without these. A release that shipped unsigned could never update itself.

**1. Get the certificate.** On your Mac, in Xcode, go to **Settings > Accounts > Manage Certificates** and add
a **Developer ID Application** certificate, if you do not have one. Then open **Keychain Access**, find it
under **My Certificates**, right-click it, and choose **Export**. Save it as a `.p12` file with a password.

Turn the file into text and copy it:

```bash
base64 -i certificate.p12 | pbcopy
```

**2. Make an app-specific password.** At [account.apple.com](https://account.apple.com), open **Sign-In and
Security**, then **App-Specific Passwords**. Apple uses this to notarise builds.

**3. Add five repository secrets.** On GitHub, open this repository's **Settings > Secrets and variables >
Actions** and add:

| Secret | Value |
| --- | --- |
| `MAC_CERTIFICATE` | The text from step 1 |
| `MAC_CERTIFICATE_PASSWORD` | The `.p12` password |
| `APPLE_ID` | The email address of your Apple Developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | The password from step 2 |
| `APPLE_TEAM_ID` | Your Team ID, under Membership details on developer.apple.com |

Delete the `.p12` file afterwards.

## Publishing a release

Releases come from `main`.

1. Merge the work you are releasing into `main`, and wait for CI to pass.
2. Run this with the new version, then one quoted line for each change. Each line appears under **What's
   new** on the release page:

   ```bash
   npm run release -- 0.2.0 "Faster checking in long documents" "Fixed the Goals dialog on small screens"
   ```

   Add `--dry-run` to see the plan without changing anything. Before it changes anything, it checks that
   the version is higher than the current one, that you have nothing uncommitted, that nobody has pushed
   since you last pulled, and that the tag does not exist yet.

3. That raises the version, commits it, tags it, and pushes. The tag starts the **Release** workflow on the
   **Actions** tab. It tests on Windows and macOS, builds everything on GitHub's machines, signs and
   notarises the Mac apps, and publishes the release. Notarising can take a while.

**If the build fails,** nothing is published. Delete the tag, fix the problem, and run the same command again.
The version is already raised, so this time it only tags and pushes:

```bash
git push origin :refs/tags/v0.2.0
git tag -d v0.2.0
```

Once a release is published it reaches everyone within a few hours, and it cannot be taken back from copies
that have updated. If a release is broken, publish a fixed one with a higher version.

## How installed copies update

Wordsmith checks the latest GitHub release 10 seconds after it starts, then every 4 hours
(`src/main/updater.ts`). A newer version downloads in the background. A banner then offers **Restart now**,
and the tray menu offers the same, for when the window is closed. If the writer does neither, it installs the
next time Wordsmith quits. **Check for Updates** in the menus and in Settings looks straight away.

The checks read files that electron-builder writes next to the installers, and the workflow attaches them to
the release: `latest.yml` (Windows), `latest-mac.yml`, and the `.blockmap` files. Mac updates install from
the `.zip`. Do not delete these from a release.

Every push runs a real update on Windows in CI (`scripts/update-test.mjs`): it installs an old version, updates
it to a newer one, and checks that the new version runs. Mac updates cannot be tested that way, because they
need signed builds. The first real test on a Mac is the second signed release.

## Signing on Windows

The Windows installer has no publisher certificate, so SmartScreen warns people the first time they run it.
Updates install without that warning. A code-signing certificate would remove it: add it to the workflow's
Windows build through `CSC_LINK` and `CSC_KEY_PASSWORD`, the same way as the Mac one.
