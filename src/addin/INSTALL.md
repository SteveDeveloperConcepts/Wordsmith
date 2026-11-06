# Installing Wordsmith in Office

Wordsmith runs in a task pane inside Word, Outlook, PowerPoint, and Excel. These steps
install it from a manifest file, so you do not need the Microsoft store or an
administrator, except where noted.

There are two manifests:

- `manifest-office.xml` for Word, PowerPoint, and Excel
- `manifest-outlook.xml` for Outlook

The steps below come from Microsoft's documentation, read on 6 November 2026. **They have
not been tried in real Office.** See [What could not be verified](#what-could-not-be-verified).

## Before you start

**The pane has to be on the web first.** A manifest only tells Office where to load the pane
from. Both manifests point at `https://stevedeveloperconcepts.github.io/Wordsmith/office/`,
and nothing is published there yet, so until it is, an installed add-in will open an
empty or failed pane.

To host the pane somewhere else, build with your own address, then upload everything in
`dist-addin/` to it. The address must use HTTPS.

```
# macOS and Linux
ADDIN_BASE_URL=https://example.com/wordsmith/ npm run build:addin

# Windows PowerShell
$env:ADDIN_BASE_URL = 'https://example.com/wordsmith/'; npm run build:addin
```

**Get the manifests** from `dist-addin/` after a build, or from the same address as the pane,
for example `https://stevedeveloperconcepts.github.io/Wordsmith/office/manifest-office.xml`.

**What you need:** Word 2016 or later, or the current Word on the web. Outlook needs support
for Mailbox requirement set 1.5. Office needs an internet connection when the pane opens,
because the pane and Microsoft's Office library both load from the web. Your text is still
checked inside the pane and is not sent anywhere.

## Word, PowerPoint, and Excel on the web

This is the simplest route and needs no changes to your computer.

1. Open [Office on the web](https://office.com/) and open a document in Word, PowerPoint, or
   Excel.
2. Select **Home** > **Add-ins**, then select **More Settings**.
3. On the **Office Add-ins** dialog, select **Upload My Add-in**.
4. **Browse** to `manifest-office.xml`, and then select **Upload**.
5. Wordsmith appears on the **Home** tab.

The manifest is stored in your browser's local storage. If you clear the browser's cache or
switch browsers, upload it again.

## Word on Windows

These steps also work for PowerPoint and Excel on Windows. Office on Windows installs from a
shared folder that you mark as a trusted catalog.

**Share a folder**

1. In File Explorer, right-click the folder you want to use and choose **Properties**.
2. Open the **Sharing** tab and choose **Share**.
3. In the **Network access** dialog, add yourself. You need at least **Read/Write** permission.
   Choose **Share**.
4. Note the full network path shown after the folder name, such as `\\MYPC\Addins`. Choose
   **Done**, then **Close**.

If Windows will not let you share a folder, see the note on administrator rights under
[What could not be verified](#what-could-not-be-verified).

**Trust the folder**

1. Open a new document in Word.
2. Choose **File** > **Options**.
3. Choose **Trust Center**, then **Trust Center Settings**.
4. Choose **Trusted Add-in Catalogs**.
5. In **Catalog Url**, enter the network path, then choose **Add catalog**.
6. Select the **Show in Menu** check box for the new entry, and choose **OK** twice.
7. Close Word and open it again.

**Install the add-in**

1. Copy `manifest-office.xml` into the shared folder.
2. In Word, select **Home** > **Add-ins**, then select **Advanced**.
3. Choose **SHARED FOLDER** at the top of the **Office Add-ins** dialog.
4. Select **Wordsmith** and choose **Add**.

Microsoft does not support shared folders for production add-ins. It suits one person or a
small test. To remove the add-in, clear the Office cache as described in
[Clear the Office cache](https://learn.microsoft.com/office/dev/add-ins/testing/clear-cache).

## Word on Mac

1. Open **Finder** and press **Cmd+Shift+G**.
2. Enter the folder below, using your own user name. If the `wef` folder does not exist,
   create it.
   ```
   /Users/<username>/Library/Containers/com.microsoft.Word/Data/Documents/wef
   ```
3. Copy `manifest-office.xml` into the `wef` folder.
4. Open Word, or restart it if it is already running, and open a document.
5. Select **Home** > **Add-ins**, and then select **Wordsmith** from the menu.

Since an Office update on 24 and 25 September 2026, a known problem means Word on Mac can
forget an add-in installed this way each time it restarts. If that happens, repeat step 5.
Microsoft is tracking it as [office-js issue 6973](https://github.com/OfficeDev/office-js/issues/6973),
and no workaround for Mac has been reported.

To remove the add-in, clear the Office cache as described in
[Clear the Office cache](https://learn.microsoft.com/office/dev/add-ins/testing/clear-cache).

## PowerPoint and Excel

Use `manifest-office.xml`, the same file as Word.

- **On the web:** follow [Word, PowerPoint, and Excel on the web](#word-powerpoint-and-excel-on-the-web).
- **On Windows:** follow [Word on Windows](#word-on-windows), in PowerPoint or Excel. A trusted
  catalog set up once applies to all three.
- **On Mac:** follow [Word on Mac](#word-on-mac) with these folders instead:
  ```
  /Users/<username>/Library/Containers/com.microsoft.Excel/Data/Documents/wef
  /Users/<username>/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef
  ```

In these two apps Wordsmith checks what you select. Select some text, open the pane, and
choose **Check selection**.

## Outlook

**Check which account you use first.** Microsoft only supports Outlook add-ins on Microsoft 365
and Outlook.com mailboxes. A Gmail or Yahoo account added to Outlook cannot run the add-in in
classic Outlook, new Outlook, Outlook on the web, or on a phone. On a Mac it works only if the
account was added with the IMAP CloudCache option. For those accounts, use Check Anywhere in the
desktop app, which works in any app with any account.

One install covers classic Outlook and new Outlook on Windows, Outlook on the web, and Outlook
on Mac, because the add-in is tied to your mailbox.

1. In a browser, go to [aka.ms/olksideload](https://aka.ms/olksideload). Outlook on the web
   opens, and the **Add-Ins for Outlook** dialog appears after a few seconds.

   In classic Outlook on Windows you can also select **File** > **Info** > **Manage Add-ins**,
   which opens the same dialog in your browser.
2. Select **My add-ins**.
3. Find the **Custom Addins** section at the bottom. Select **Add a custom add-in**, then
   **Add from File**. The **Add from URL** option no longer exists, so download the manifest
   first.
4. Pick `manifest-outlook.xml` and accept the prompts.

In classic Outlook on Windows it can take up to 24 hours for the add-in to appear, because of
caching.

If **Add a custom add-in** is missing, your organization may have taken away the **My Custom
Apps** role. Only an administrator can give it back.

**Open it while writing a message**

- **Classic Outlook on Windows:** on the **Message** tab, select **Check draft**. If it is not
  there, select **All Apps**, which may be under the `...` button. The Reading Pane must be set
  to Right or Bottom (**View** > **Reading Pane**), or add-ins are unavailable.
- **New Outlook on Windows and Outlook on the web:** on the **Message** tab, select **Check
  draft**. If it is not there, select **Apps**.

You can pin the pane, and it stays pinned the next time you write a message. Pinning needs a
Microsoft 365 subscription and is not available on Outlook.com.

**To remove it,** open the same dialog, find the **Custom Addins** section, choose the `...` next
to Wordsmith, and choose **Remove**.

### What a fix does in Outlook

Outlook lets an add-in change a draft only by replacing all of it, so a fix behaves differently
from typing. The pane tells you which of these applies to you.

| | Classic Outlook | New Outlook and the web | Outlook on Mac |
| --- | --- | --- | --- |
| Where the cursor goes | Start of the message | End of the message | Disappears until you click in the message |
| Ctrl+Z or Command+Z | Cannot take it back | Not documented | Cannot take it back |

Use **Undo** in the pane to take back a fix. Your signature and the earlier messages in a reply
are not checked, and are written back exactly as they were.

New Outlook has been seen breaking inline pictures when a draft is rewritten
([office-js issue 6997](https://github.com/OfficeDev/office-js/issues/6997)) and losing content
from drafts with about ten or more pictures or file links
([issue 6944](https://github.com/OfficeDev/office-js/issues/6944)). The pane warns you about
pictures and will not rewrite a draft with that many. Check pictures before you send.

## Updating

The pane updates itself when you replace the files on the web. Install a manifest again only if
the manifest itself changes.

## What Centralized Deployment gives an organization

An administrator can install Wordsmith for other people from the Microsoft 365 admin center,
under **Settings** > **Integrated apps**. That route needs admin rights, but nothing from the
people receiving it:

- It can go to one person, to groups, or to everyone in the organization.
- The add-in downloads by itself when the Office app starts, and its button appears on the
  ribbon, on Windows, on Mac, and on the web.
- It disappears if the administrator turns it off or deletes it, or if someone leaves the
  assigned group.
- It can take up to 24 hours to reach everyone.
- Microsoft suggests rolling out to a small group first.

It needs a Microsoft 365 Business or Enterprise plan, or Office 365 Enterprise. It is the
supported way to run an add-in like this across an organization, and unlike a shared folder it
reaches Mac and the web. The integrated apps portal is not available in sovereign or government
clouds, which use the older add-in deployment page instead.

## What could not be verified

No step here was tried in real Office, in any version, on any platform.

- **Administrator rights on Windows.** Microsoft's steps do not say whether sharing a folder needs
  an administrator, and on a locked-down computer it may. If it does, use Word on the web, or
  ask someone to give you a folder on an existing network share. Nothing we found confirms that a
  local path such as `C:\Addins` works as a catalog, only network paths.
- **Personal Microsoft accounts in Outlook.** Microsoft says add-ins run on Outlook.com, but its
  help page also says Outlook on the web needs a work or school account, and one person reported
  in December 2024 that the upload option had gone from their personal account. We could not
  settle this.
- **Opening the pane in Outlook on Mac.** The article we read has no steps for Mac, so they are
  left out above. Expect it to work like the other clients.
- **Undo in new Outlook and on the web.** Microsoft documents that classic Outlook and Mac cannot
  undo a fix with the keyboard, and says nothing either way about these two.
- **Word on Windows after restarting.** Issue 6973 says a shared folder catalog is not affected.
  That is one person's report.
- **Using the pane offline.** The pane and the Office library both load from the web. Whether
  Office can open the pane from its cache with no connection was not tested.
- **Settings across apps.** Microsoft does not support sharing stored data between Office apps, so
  expect each app to keep its own settings and dictionary.
