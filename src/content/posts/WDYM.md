---
title: "real-time patching"
pubDate: "2026-04-21"
description: "three words that took a whole runtime to make true"
author: "woflo"
images:
  - url: "/images/wdym-cover.webp"
    alt: "College Capstone 2026"
---

> Three words.
>
> *three very smug words, honestly.*

They sound small. Clean. Self-explanatory. You say them out loud and your brain helpfully supplies a fake mental image of what must be happening. The machine is running. The patch goes in. Everybody pretends this is a normal thing to do to a live Java game.

Which, to be clear, *it is not*.

That was more or less the sales pitch in my own head when this capstone started.

## The original fantasy

I wanted to put an LLM inside Minecraft and see what would happen if it had enough access to do more than generate pretty text in a side panel. Answering questions was easy. Summarizing files was easy. Cosplaying competence from static snippets was easy. I wanted it in the runtime. In the mess. Looking at the same burning machinery I was looking at.

Part of that was simple curiosity. **LLM tech is cool.** Lowkey an embarrassing sentence to write with a straight face, but that doesn't make it less true. The more important part was the shape of the opportunities I saw. Once you have a system that can generate basically any text, any code, any structured output, non-deterministically (both good and bad), the interesting questions shift. The generation stops being the trick. The trick is what kind of real-time possibilities open up once that generator is trapped inside the right harness.

That was the real hook.

I do not like being limited by my own brain more than I am limited by the technology. If there is a way to build a machine that can inspect a living system, build context, take actions, and stay inside a live loop, I'd like to see how far that goes. At some point the question stops being about what the model can write and starts becoming what you can safely let it touch.

### Why Minecraft

Minecraft was a very good place to run that experiment.

It is deterministic enough to reason about. Chaotic enough to be funny. It already has all the things you want in a runtime playground: state, events, side effects, hidden information, weird edge cases, and plenty of opportunities to break something in a way that feels educational right up until it is your fault. It also lives on the JVM, which meant I could get much closer to the metal than a polite software project usually encourages. Or, less politely put, it meant I could commit code crimes with structure.

So the first version of the idea was straightforward.

- Give the model a way to inspect what is happening.
- Give it enough context to not be blind.
- Give it tools.
- Let it patch live behaviour.
- See whether this becomes useful or just deeply cursed.

## What I thought would be hard

I assumed the patching would be the hard part.

That assumption lasted a while, mostly because it sounded reasonable. Live patching is the kind of phrase that arrives wearing a hazard tape dress. Draped head to toe in chic problems. After all, is bytecode involved. There are hooks involved. There is even a live game involved. All melded with a non-deterministic system. If you put those ingredients on a table and ask which one will consume your life first, patching seems like a fair guess.

**The patching was hard, just not in the way I thought. It was the visible problem, not the largest one.**

Throughout development, WDYM never really became a *different* project. What changed was how much had to grow around the original idea before it could hold its shape.

Every time I thought I had isolated the problem, another surrounding system showed up and demanded to be part of it.

- Simple log tracking helped, until it did not.
- Simple hooks worked, until they very much did not.
- Then error handling mattered, because the moment the agent starts reading the world through broken tools or partial context, it does not heroically recover. It confidently wanders off into fiction.

Then context started to metastasize.

*This is a VERY rude thing for a project to do, but unfortunately common.*

## The runtime grows around the idea

Static file snippets were not enough. Plain logs were not enough. One-shot prompts were not enough. The system needed continuity. It needed a memory of what had already happened in the session. It needed to know whether the thing it was looking at came from vanilla Minecraft, a mod, a library, or some horrifying liminal layer between them. It needed source visibility. It needed decompilation. It needed action boundaries. It needed enough structure around intervention that `"do something"` could be separated from `"observe something"` before the whole thing dissolved into plausible but unauditable behaviour.

This is the point where **"real-time patching"** started expanding from three words into a whole ecosystem of annoying necessities.

### What those three words were hiding

- **A conversational runtime**
- **Live state capture**
- **Session continuity**
- **Source resolution**
- **Decompilation**
- **Action tooling**
- **Runtime surgery**
- **Reactive conditions**
- **Watchdogs**
- **Error recovery**
- **EDGE CASES!!! :(**

None of those sound as sexy on a poster, which is unfortunate because that is where the actual work lived. Nobody has ever slammed their hand on a table and yelled **hell yes, session continuity!!**

The project slowly stopped feeling like a mod with a cool feature and started feeling like a runtime that happened to be wearing Minecraft as a skin.

By the end, it had put a mask on itself. Underneath, it was still the same idea. Just uglier, messier, and carrying far more machinery than it had at the start.

At a certain point I kept asking myself the same question in slightly different forms. If this needs more and more of the runtime to become trustworthy, where does the boundary actually sit? Is this still just a Minecraft thing? Is this an engine-level idea hiding in a game because the game is a convenient sandbox? If I did this in Unreal or Unity, would the core logic even change that much, or would the skin just be different?

I think I knew the answer before I said it clearly.

> You do not get consistent live patching without a runtime around it.
>
> You get a trick.
>
> Maybe a good trick. Maybe even a very funny trick.
>
> But it's still a trick.

**Tools do not get the same mercy as demos.**

A tool has to survive contact with bad inputs, missing context, weird states, partial failure, and the user doing something stupid because users are committed to the art form. A tool has to earn the right to be boring. If it cannot be boring, it cannot be trusted. If it cannot be trusted, it is just another charismatic lab accident.

That was the real project.

## The visible hook versus the actual work

From the outside, the obvious question was whether I could make the model patch code while the game was running.

Fair question. Also a slightly deceptive one. Patching is the part that gets noticed easily. What mattered during development was everything that had to be in place before a patch could mean anything at all.

That difference matters because LLMs are, for all their weirdness, still just prediction machines. They are extraordinarily good autocompletes. I do not mean that as an insult. If anything it makes them more interesting. Good autocomplete, if you build around it properly, gets stupidly capable. It can draft, reason, restructure, synthesize, and surprise you. But it can also dump *industrial-grade slop* directly into your lap with complete confidence if the input is muddy enough.

*Slop in, slop out.*

That rule does not stop applying just because the output is impressive. The same thing happens with context. When the system can actually see what is going on, the behaviour sharpens up. When visibility gets muddy, it starts improvising around the edges of reality. Sometimes that still works. A good runtime is more than just luck wearing a nice shirt.

So a lot of WDYM became an exercise in making the runtime honest enough that prediction had something real to cling to.

### What grounding actually meant

That meant:

- capturing live game state instead of hoping a prompt would magically carry enough detail
- keeping session details around instead of treating every interaction like amnesia with an input field
- resolving actual source and decompiling real classes to get the models closer to the truth when they want it
- building an action model where reads, diagnoses, triggers, and patches had distinct shapes
- handling error paths as first-class citizens, because a runtime that only works when nothing weird is happening isn't very useful

## The moment it clicked

One of the first moments where the project felt properly real was the first time the patch tool worked and I did not have to argue with it in the slightest.

That sounds like a low bar. It was not.

I had built enough systems by that point to understand exactly how many things could go wrong between `"I think this should be possible"` and `"it actually happened inside the running game and did not burst into flames."` I, like any programmer, did not trust it yet. *Then the patch landed first try*.

That was a very specific kind of relief.

**It all clicked there. I saw it do the thing I had been building it to do. Live. In front of me.** ***Unprompted.***

The harness hit friction in one of its own read paths. **A genuine bug.** Instead of stalling, it reasoned through what the tool was supposed to do, patched around the failure so it could keep working, used that patched path to continue the job, and then reported the underlying issue back to me at the end for the real fix outside the patch environment. That was when WDYM stopped feeling like a clever setup and started feeling like a tool that knows its potential.

It was not triumph, and it definitely was not cinematic victory. It felt more like the quiet little psychic click of a machine finally agreeing to stop embarrassing me in its own habitat.

## Where the suffering actually lived

Of course, the glamorous parts were not where most of the suffering lived.

The player-facing parts were some of the worst. Resonance Scryer gave me the kind of trouble that only regex can give, which is to say deeply personal trouble from a fundamentally impersonal technology. The Doctor screen ballooned into a 4000+ line godfile because of course it did. Would you believe me if I told you the file asked to be that large? Cause it's cause.

The thing the player sees and touches is always where all the clean ideas come back as UI problems. Architecture is clean right up until it has to become an interface. Then it turns back into plumbing, adhesive, and mild swearing.

That mess matters too.

If I write this post as though the project unfolded in a sequence of noble insights and elegant abstractions, it just wouldn't be true. A lot of it was just dark rooms and engineering work. Staring at a behaviour that *should* be possible... building a little more machinery around it then finding out the machinery needed machinery; and its machinery needed machinery too. Watching the harness get more invasive because the alternative was settling for subpar, unreliable behaviour.

## What WDYM became

By the end, the phrase **"AI in Minecraft"** had started annoying me.

It is technically true. Those are often the most annoying kinds of wrong.

By that point, what interested me was no longer "AI in Minecraft." It was the broader problem of using non-deterministic generators inside deterministic environments without the whole thing turning into performance theatre. Minecraft was the starting point, not the destination. The larger idea had been there the whole time.

If a model can generate arbitrary text or code, then a whole spectrum of real-time possibilities opens up. The limiting factor stops being the generator in isolation. It becomes the runtime around it, and the person clever or stupid enough to build that runtime.

**That is a better limitation to run into. At least it is real.**

By the time WDYM was done, **"real-time patching"** still sounded cool, but it no longer felt like the headline. It felt like the compressed surface of a larger structure. A tidy phrase sitting on top of context pipelines, runtime inspection, session memory, source truth, tool orchestration, bytecode surgery, reactive systems, UI/UX, and all the other invisible nonsense required to make a non-deterministic model stop acting like a stage magician and really belong as part of the toolchain.

I still like the three words...

They are liars...

***Very efficient liars.***

And I think that is why I like the project so much.

## The actual takeaway

WDYM did not teach me that LLMs are magical. If anything, it pushed me in the other direction. The less mysticism I projected onto them, the more useful they got. Put one in a real runtime. Let it inspect actual state. Give it enough evidence that its outputs can be checked against something other than vibes. Suddenly the novelty is not that it can generate things. The novelty is how much opens up once generation can touch a live system.

That was the capstone.

By the end I was looking at a runtime harness that let a prediction machine do useful work inside a deterministic system. It lived in a game, yes. It could patch live behaviour, yes. It also had enough surrounding structure to be something harsher and more interesting than a toy.

AI isn't about the model itself, it's about the system as a whole and how every piece comes together to multiply the overall force potential of the unit. That's how we work as humans, isn't it? We have a series of organs; a brain, a body / 'meat suit', and a nervous system. Those work together to act out you, me, and everybody else. The magic isn't the tongue, the environment, or the brain itself, its the way these tools come together to convey our abilities, intentions, or goals.

how's that for philosophy?
