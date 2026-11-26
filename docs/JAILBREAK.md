# Prepare the Kindle: jailbreak and KUAL

The guide for parents is also a web page: https://zaqifathis.github.io/kindle-dashboard/#prepare (source: `docs/index.html`). A copy is also in the Claude Docs page "Prepare your Kindle". When you change a step, keep all copies the same.

Kid Planner is tested on a Kindle Paperwhite 3 (7th generation, 2015). Other touch Kindles with a screen from 758 to about 1264 pixels wide can work, but nobody tested them yet. Before Kid Planner can run, the Kindle needs two things:

- A jailbreak. A jailbreak lets the Kindle run programs that Amazon did not make.
- KUAL. KUAL is a menu on the Kindle that starts these programs. Kid Planner appears in this menu.

The Kid Planner Setup app does most of the work for WinterBreak, the jailbreak that most Paperwhite 3 Kindles get. For another jailbreak, you do the jailbreak by hand, and the app installs KUAL.

This guide follows kindlemodding.org, the website of the Kindle modding community. Amazon changes the Kindle software often, and the jailbreak methods change with it. If a step here is different from kindlemodding.org, do what kindlemodding.org says.

## Before you start

Warning: A jailbreak can fail, and a failed jailbreak can make the Kindle unusable. Back up your books first.

Warning: Do not do a factory reset during or after the jailbreak unless an experienced person tells you to. A factory reset can remove the jailbreak or lock the Kindle.

You need:

- The Kindle and its USB cable.
- A computer with the Kid Planner Setup app (Mac or Windows).
- A Wi-Fi network.
- A Kindle that is registered to an Amazon account. WinterBreak uses the Kindle Store.

### Back up your books

When you click Copy the jailbreak, the Setup app does this for you. It copies the `documents` folder of the Kindle to a new folder `Kindle backup <date>` in the Documents folder on your computer.

To back up by hand:

1. Connect the Kindle to the computer with the USB cable.
2. Open the Kindle drive in Finder (Mac) or File Explorer (Windows).
3. Copy the folder `documents` to your computer.
4. Eject the Kindle.

Books that you bought from Amazon are also in your Amazon account, and you can download them again.

### Remove the screen password

1. On the Kindle, tap the three dots (Menu) at the top right.
2. Tap Settings, then Device Options, then Device Passcode.
3. Type the current passcode, then turn the passcode off.

If parental controls block the Kindle Store, open Settings > Parental Controls > Restrictions and allow the Kindle Store. The menu names can be a little different on your Kindle model.

## Step 1: Find the firmware version

The firmware is the Kindle's own software. The right jailbreak depends on its version.

1. On the Kindle, tap the three dots (Menu) at the top right.
2. Tap Settings, then Device Options, then Device Info.
3. Write down the firmware version, for example `5.16.21`.
4. Write down the first 8 characters of the serial number on the same screen.

## Step 2: Find the right jailbreak

1. Open kindlemodding.org/jailbreak-wizard.html on your computer.
2. Enter the serial number, the firmware version, and the other answers that the wizard asks for.

If the wizard says that no jailbreak exists for your firmware, stop here. You cannot install an older firmware without a jailbreak. You must wait until the community releases a new jailbreak.

WinterBreak does not work on firmware 5.18.1 or newer. If the wizard names WinterBreak, do Step 3A. If it names another jailbreak, do Step 3B.

## Step 3A: WinterBreak with the Setup app

1. On the Kindle, turn on Airplane Mode, then restart the Kindle.
2. Connect the Kindle to the computer.
3. In the Setup app, click Prepare my Kindle, then Copy the jailbreak. The app backs up the books and copies WinterBreak to the Kindle, with the hidden folder `.active_content_sandbox`. Then it fills the storage until about 70 MB is free. A full Kindle cannot download an Amazon update during the jailbreak. This can take about 10 minutes.
4. Eject the Kindle on the computer, then unplug the cable.
5. On the Kindle home screen, tap the cart icon to open the Kindle Store.
6. When the Kindle asks to turn off Airplane Mode, tap Yes.
7. A page called Mesquito opens. Tap the WinterBreak icon.
8. Wait about 30 seconds. Lines of text fill the screen, and the Kindle restarts its home screen. This means the jailbreak worked. If no text appears, do steps 5 to 7 again. The WinterBreak page on kindlemodding.org has a troubleshooting section for other problems.
9. Connect the Kindle to the computer again. In the Setup app, click Install KUAL. The app deletes the filler files and every file in the top folder whose name ends in `.bin`, then copies KUAL.

WinterBreak blocks automatic Amazon updates for you, and it installs the hotfix. The hotfix is a small program that keeps the jailbreak after an Amazon update.

## Step 3B: Another jailbreak

1. Follow the instructions for your jailbreak on kindlemodding.org.
2. If you filled the storage, delete the filler files.
3. Connect the Kindle to the computer. In the Setup app, click Prepare my Kindle, then Install KUAL. Do not click Copy the jailbreak, because it copies WinterBreak.

The app does not install MRPI, because Kid Planner does not need it. If you want MRPI for other programs, follow the page "Installing KUAL and MRPI" on kindlemodding.org.

## Step 4: Check KUAL

1. Eject the Kindle, then unplug the cable.
2. Open the Kindle library. A book called KUAL appears. Tap it to check that the KUAL menu opens.

## Step 5: Install Kid Planner

1. In the Setup app, follow the steps. When it asks, connect the Kindle with the USB cable. The app copies Kid Planner to the Kindle by itself.
2. Eject the Kindle, then unplug the cable.
3. On the Kindle, open KUAL. Tap Kid Dashboard, then Start dashboard.

From then on, the planner starts by itself every time the Kindle turns on.

## Keep the Kindle working

- Keep automatic updates blocked. An Amazon update can remove the jailbreak.
- If an update installed anyway and KUAL is gone, check kindlemodding.org. Run the hotfix again, or wait for a new jailbreak, as the site tells you.
- To use the Kindle as a normal e-reader again, open the web dashboard. In the Kindle tab, click "Return to normal Kindle". The planner covers the whole Kindle screen, so you cannot open KUAL while it runs.
