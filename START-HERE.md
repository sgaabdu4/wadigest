# Start here

You need two things:
- the computer that will send the summaries
- the phone with the WhatsApp account that's in your groups

It takes about 10 minutes, once.

## Steps

1. **Install it.**
   - Mac: open **Terminal**, paste this line and press Enter:
     `curl -fsSL https://raw.githubusercontent.com/sgaabdu4/wadigest/main/get.sh | bash`
   - Windows: open **PowerShell**, paste this line and press Enter:
     `irm https://raw.githubusercontent.com/sgaabdu4/wadigest/main/get.ps1 | iex`
   - Or, if someone gave you the folder: double-click **Start wadigest**. On a Mac, if it says it can't open it, right-click it, choose **Open**, then **Open** again.
2. **A page opens in your browser.** If it says "Getting ready", wait. Leave the Terminal or PowerShell window open.
3. **Scan the code.** On your phone, open WhatsApp, then Settings, Linked devices, Link a device. Point the phone at the code on the page.
4. **Tick your groups**, then press **Continue**.
5. **Read the sentence.** It says when the summary is sent. Tap a green word to change it. Then press **Start**.
6. **Press Preview** to see what it would send. Nothing gets sent.

That's it. You can close the page and the window. If the computer asks whether to stop the running process, say yes. wadigest keeps running in the background.

## After that

- On schedule, each group gets its summary in the group, pinned, and by private message to each member. You chose which in step 5.
- The computer can be asleep. It catches up when it wakes, up to 3 days late.
- To change anything, open the page again: type `wadigest` in Terminal, or double-click **Start wadigest**.
- **Invite** shows a code your group members can scan to sign up.

## If something goes wrong

Take a screenshot of the page and send it to whoever set this up. If they ask for logs, they're in the `.wadigest/logs` folder in your home folder.
