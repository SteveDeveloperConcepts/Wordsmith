/** What someone sees if they open the page outside Office, or Office never answers. */
export function NoOffice() {
  return (
    <main className="no-office">
      <h1>Wordsmith for Office</h1>
      <p>This page runs inside Word, Outlook, PowerPoint, and Excel. On its own in a browser it has nothing to check.</p>

      <h2>Word, PowerPoint, and Excel</h2>
      <ol>
        <li>
          Download <a href="manifest-office.xml" download>manifest-office.xml</a>.
        </li>
        <li>
          On the web, open a document and choose Home, Add-ins, More Settings, then Upload My Add-in, and pick the file.
          On a Mac, copy it into the app's wef folder. On Windows, share a folder and add it as a trusted add-in catalog.
        </li>
      </ol>

      <h2>Outlook</h2>
      <ol>
        <li>
          Download <a href="manifest-outlook.xml" download>manifest-outlook.xml</a>.
        </li>
        <li>
          Go to <a href="https://aka.ms/olksideload">aka.ms/olksideload</a>, choose My add-ins, then Add a custom add-in,
          then Add from File, and pick the file.
        </li>
      </ol>

      <p>
        The full steps for each app are in INSTALL.md in the{' '}
        <a href="https://github.com/SteveDeveloperConcepts/Wordsmith">Wordsmith repository</a>.
      </p>
      <p className="no-office__note">
        If you see this inside Office, the Office library could not load. It comes from Microsoft, so Office needs an
        internet connection the first time the pane opens.
      </p>
    </main>
  );
}
