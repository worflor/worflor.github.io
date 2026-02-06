---
title: "Minecraft Server Maintainer, but a blog post"
pubDate: 2026-02-06
description: "\"wow its so small!\" - you, maybe"
author: "woflo"
images:
  - url: "/images/mc-server-maintainer.webp"
    alt: "Minecraft Server Maintainer, but a blog post"
---

# the tl;dr

it does everything you could ever need a headless little tool to do, and it's roughly 55kb, IN JAVA!

# maintaining a server

so. theres this cycle that occurs a few times a year to every friend group. the "2 week minecraft phase".

the most unspoken rule of this phase is that the server owner does **ALL** the work, and also, if the server breaks, it's your fault, and fix it, preferably now.

as someone who already runs a few game servers, i'm pretty familiar with this cycle and have gotten efficient with my deployment. do I use docker? NO. it's a minecraft server. I just used the standard "run.bat" file I brought to all my servers. Was it special? no. But it worked.

but i got lazy. and yet had dreams too... *a sinister combo.*

so I experimented with 'self reviving' batch scripts paired with 'mod / version updating' powershell scripts. it was a mess... a beautiful mess... but it was a mess. a mess that barely even worked! so maybe it was more of an embarrassing mess.

all that came from was a simple idea: "what if there was a tool that did all the boring stuff for you?" I didn't want to use docker. I didn't want to use a web dashboard. I just wanted a simple tool that did the boring stuff for me. 

so I pulled out rust-

no.

I took a step back. Right now it's a "run.bat" and "update.ps1" system, but realistically that doesn't scale well to multiple platforms. and I wanted something that could run on anything. hmm... wait a minute, say that again...

# run on anything...

there's one language that's well known for being able to run on anything. and thats java. bonus points, it's also what minecraft is written in. meaning people who already run servers are likely to have java installed, no extra dependencies needed.

that "no extra dependencies" became a minor obsession of mine. I refused to import a single library. I didn't want to pull a 2MB json parser like Jackson when I could just write my own specialized one in ~80 lines.

> so what does this thing do?
> - you, probably.

server maintainer sits in your server folder (or the woflo/ folder if you wanna hide it), and can:

- on restarts, check if there's a new minecraft version
- on restarts, check if your mods/plugins have updates on modrinth
- make sure everything's compatible before touching anything
- back up automatically before any changes, allowing the system to "undo" if something goes wrong.
- update everything through modrinth
- start your server, or restart it if it goes down
- keeps it down if it crashes 3 times in 5 minutes
- does it all again next time!!!

that's it. no web dashboard. no account to create. no subscription. AND NO DOCKER. just a jar file that does the boring stuff so you can focus on actually playing.

the loaders

works with pretty much everything:
- fabric
- forge
- neoforge
- quilt
- paper/purpur/folia
- vanilla
- wow!

it figures out what you're running automatically. just drop it in and go.

## does size matter?

the whole thing is **54kb** as of beta-1.0.4.

that's smaller than most images on a webpage. smaller than a single minecraft texture. i spent way too long making it this tiny and i'm unreasonably proud of it.

no dependencies. no frameworks. just java doing java things.

## the vibe

i wanted something that felt invisible. run it once and completely forget about it. your server stays updated, backed up, and running. Or just running if you don't care for auto-updates. 

no notifications. no emails. no "upgrade to pro for more features." Just a [tiny](https://en.wikipedia.org/wiki/Waist) tool that does one job well.

---

it's free, it's open source, and it's probably running my server right now while i'm writing this.

- me