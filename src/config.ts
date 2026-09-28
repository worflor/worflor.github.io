import type {
  NavBarLink,
  SocialLink,
  Identity,
  AboutPageContent,
  ProjectPageContent,
  BlogPageContent,
  HomePageContent,
  ContactPageContent,
  FreelanceBriefContent,
} from "./types/config";

export const identity: Identity = {
  name: "Michael Bickford",
  logo: "/images/logo.webp",
  email: "wofloemail@gmail.com",
  github: "https://github.com/worflor",
  x: "https://x.com/altwof",
};

export const navBarLinks: NavBarLink[] = [
  {
    title: "About",
    url: "/about",
  },
  {
    title: "Endeavours",
    url: "/projects",
  },
  {
    title: "Blog",
    url: "/blog",
  },
];

export const socialLinks: SocialLink[] = [
  {
    title: "GitHub",
    url: identity.github,
    icon: "mdi:github",
    external: true,
  },
  {
    title: "X",
    url: identity.x,
    icon: "x:logo",
    external: true,
  },
  {
    title: "LinkedIn",
    url: "https://www.linkedin.com/in/michael-bickford-0aa209211/",
    icon: "mdi:linkedin",
    external: true,
  },
  {
    title: "Mail",
    url: `mailto:${identity.email}`,
    icon: "mdi:email",
  },
];

// home
export const homePageContent: HomePageContent = {
  seo: {
    title: "woflo",
    description:
      "Software developer and independent researcher building tools, interactive systems, games, and mathematical experiments.",
    image: identity.logo,
  },
  role: "Software Developer & Independent Researcher",
  description:
    "I'm Michael, a software developer and independent researcher who fixates on little details. I build tools, interactive systems, and mathematical experiments, usually by following one question farther than I meant to. I love tech. It's cool as hell, even when it scares me.",
  socialLinks: socialLinks.filter(link => link.title !== "LinkedIn"),
  links: [
    {
      title: "Endeavours",
      url: "/projects",
    },
    {
      title: "About Me",
      url: "/about",
    },
  ],
};

// about
export const aboutPageContent: AboutPageContent = {
  seo: {
    title: "About | woflo",
    description:
      "Software developer and independent researcher from Canada, building tools, games, interactive systems, and mathematical experiments.",
    image: identity.logo,
  },
  subtitle: "hey, let's get to know each other.",
  about: {
    description: `
I'm Michael, a software developer and independent researcher from Canada. I like to do things ;]
<br/><br/>
Through the miracle of osmosis, I came here through theatre and teaching, then game development, and kept wandering into software, game modding, networking, mathematics, and whatever else a project asked of me.
<br/><br/>
Every day I find I'm learning something new about the world, even if it's against my will.
<br/>
Oh, *knowledge*. <3`,
    images: [
      {
        src: "/images/raccoon.webp",
        alt: "A fat raccoon I found on Campus one day.",
      },
      {
        src: "/images/humber-pic-thing.webp",
        alt: "Humber College looking pretty.",
      },
      {
        src: "/images/the-scenery.webp",
        alt: "The scenery of campus.",
      },
    ],
  },
  work: {
    description: `To me, programming languages are tools, and I'm always picking up new ones for random purposes. I started with **C++** and shader languages like **GLSL**, then branched into **Java (21+)**, **Python**, **TypeScript**, **Dart**, and **Rust**, choosing whichever language best fit the research or system I wanted to explore.
    <br/>
    Why? Check out my Projects and/or Blog page!`,
    items: [
      {
        title: "Game Developer",
        company: {
          name: "Student",
          image: identity.logo,
          url: identity.github,
        },
        date: "2023 - Present",
        summary: "Making games, mechanics, UI / UX, and the weird little systems around them until they feel built right. I care a lot about immersion and satisfying feel.",
        tags: ["Unreal", "C++", "Mechanics", "Systems Design", "Immersive Experiences"],
      },
      {
        title: "Tool Maker",
        company: {
          name: "Freelance",
          image: identity.logo,
          url: identity.github,
        },
        date: "2025 - Present",
        summary: "Small software, developer tools, systems experiments, and utility projects, built with a bias toward low latency, explicit behavior, and testable claims.",
        tags: ["Java 21", "Dev Tools", "Systems", "Experiments", "Low Latency"],
      },
    ],
  },
  connect: {
    description: ``,
    links: [
      {
        title: "Endeavours",
        url: "/projects",
        icon: "woflo:projects",
      },
      {
        title: "Blog",
        url: "/blog",
        icon: "woflo:blog",
      },
      {
        title: "Contact Me",
        url: "/contact",
        icon: "woflo:contact",
      },
      {
        title: "Mail",
        url: `mailto:${identity.email}`,
        icon: "mdi:email",
      },
      {
        title: "GitHub",
        url: identity.github,
        icon: "mdi:github",
        external: true,
      },
      {
        title: "X",
        url: identity.x,
        icon: "x:logo",
        external: true,
      },
      {
        title: "LinkedIn",
        url: "https://www.linkedin.com/in/michael-bickford-0aa209211/",
        icon: "mdi:linkedin",
        external: true,
      },
      {
        title: "Resume",
        url: "/resume.pdf",
        icon: "mdi:file-document-outline",
        external: true,
      },
    ],
  },
};

// projects
export const projectsPageContent: ProjectPageContent = {
  seo: {
    title: "Endeavours | woflo",
    description:
      "Things I've built: an anti-Synapse for Razer gear, a git client that reads your codebase as a manifold, browser-native encrypted messaging, and the research underneath them.",
    image: identity.logo,
  },
  subtitle: "some endeavours.",
  projects: [
    {
      title: "Neuron",
      description:
        "An anti-synapse for your Razer gear. One small binary that replaces Razer Synapse, talking to your mouse and keyboard directly over raw HID: the same bytes, worked out from wire captures and a lot of live probing. No kernel driver, no vendor SDK, no account, no cloud.<br>Everything is one sentence, <em>when this, do that</em>: bind any trigger to any action. A composable lighting engine, gesture spellweaving by eigenmotion, real-python macros, and first-class hypershift fall out of that one pairing.<br>Windows-first, one developer, your config plain TOML you own.",
      image: "/images/neuron-portfolio-color.webp",
      month: "July",
      year: "2026",
      url: "/neuron",
      slug: "neuron",
      github: "worflor/neuron",
      trackRelease: true,
    },
    {
      title: "Manifold",
      description:
        "Git desktop client. Your codebase is a manifold.<br>Change one file and it follows the nearby structure through a graph built from repository history. Heat spreads toward related files; curvature helps surface the bridges your architecture leans on.<br>Flutter, Dart, and a bit of spectral geometry.",
      image: "/images/manifold",
      month: "April",
      year: "2026",
      url: "https://github.com/worflor/git-desktop-premium-ultra-promax-plus-R",
      github: "worflor/git-desktop-premium-ultra-promax-plus-R",
      slug: "manifold",
    },
    {
      title: "Whisper",
      description: "Encrypted communication over Möbius geometry, built in the browser.<br>Tuck an encrypted message inside an ordinary file, or open a peer-to-peer session protected with authenticated encryption.<br>Möbius-derived prediction shapes the codec; standard cryptography protects the message.",
      image: "/images/whisper.webp",
      month: "February",
      year: "2026",
      url: "/whisper?live",
      slug: "whisper",
    },
    {
      title: "Lore",
      description:
        "A small world made of your cards.<br>A private-first place to explore who you are, show someone what feels true, and build a mythology together. Keep your own story; choose what you share. Tarot, astrology, and interactive play are instruments.<br>There's an owl. You can give it a card.",
      year: "2026",
      url: "/lore",
      // day, dusk and night: the card shows the owl's step at the visitor's own hour, as /lore does
      image: "/images/lore",
      slug: "lore",
      status: "in-development",
    },
    {
      title: "Scryer",
      description:
        "Exact mathematics for systems that guess.<br><br>Scryer gives a research agent exact mathematical objects to work with. The agent decides what to try; Scryer derives what it can, finds counterexamples, and sometimes leaves evidence you can replay.<br><br>The focus now is discovery: letting the agent use established results to choose its next question.",
      month: "May",
      year: "2026",
      url: "/scryer/",
      slug: "scryer",
      status: "active-research",
    },
    {
      title: "What Do You Mean?",
      description: "In-game agentic debugger for Minecraft, split between two agents.<br>The Doctor reaches into a running mod and rewrites its bytecode on the fly, setting soft breakpoints through a Condition Compiler wherever you need them. The Watchdog never touches a thing; it just keeps a quiet eye on the server's tick rate, waiting for the moment something slips.<br>A college capstone on Fabric 1.21, built test-first.",
      image: "/images/wdym-cover.webp",
      month: "April",
      year: "2026",
      url: "/blog/wdym",
      slug: "wdym",
    },
    {
      title: "Project Pocket",
      description: "A file scattered into unrecognizable pieces across a public BitTorrent swarm.<br>The concept uses a shared handshake to recover the structure needed to put those pieces back together. Without it, the swarm only sees unrelated blobs.",
      year: "2026",
      url: "/contact?project=pocket",
      // linked as "pocket" long before this field existed, and a slug derived
      // from the title would silently become "project-pocket" and break it.
      slug: "pocket",
      status: "concept",
    },
    // hindsight is resting out of sight for now. uncomment to bring it back.
    // {
    //   title: "hindsight",
    //   description: "hindsight is 20/20, and your gameplay just got clipped in 4K.<br>Vulkan lifts each frame off the swapchain and Lumen folds them into one continuous light field. All the while, Glyph is reading your hands as 7D kinetic strokes, so the way you played is baked into the recording as an eigenidentity.",
    //   year: "2026",
    //   url: "/contact?project=hindsight",
    //   slug: "hindsight",
    //   status: "parked",
    // },
    // prisma is resting out of sight for now. uncomment to bring it back.
    // {
    //   title: "Project Prisma",
    //   description: "Footage in superposition. Every frame holds every possible cut.<br>Prisma is the measurement. The Whisper codecs already produce a surprise signal for every byte, every sample, every frame. Read those signals as attention, weight them, collapse the timeline. The edit was always in the recording; nobody had a way to find it.",
    //   year: "2026",
    //   url: "/contact?project=prisma",
    //   slug: "prisma",
    //   status: "concept",
    // },
    {
      title: "wick",
      description:
        "point it at a folder, ask, and back comes a focused packet of *your own* passages, each tagged with why it's there.<br>one SQLite file, no embedding server, no GPU, no model download. it trains the semantic space on your corpus and runs heat-kernel diffusion over the document graph (math from the 1800s), so it reads structure flat embeddings miss, and it'll even tell you what's *missing*. ~1ms warm.<br>real and running, paused at “works, not yet right” while i chase the piece it's still missing.",
      year: "2026",
      url: "/contact?project=wick",
      slug: "wick",
      status: "parked",
    },
    {
      title: "séance",
      description:
        "run an LLM straight from cold SSD. no GPU, no inference framework, and no need to keep the model weights resident in RAM.<br>the roughly 197KB Rust binary memory-maps safetensors and reads each matrix as it is needed. it has been tested on 12 models across 10 architecture families, from 0.5B to 9B parameters. the 19GB Qwen3.5-9B run used under 2MB for its own runtime state and generated at about 0.5 tok/s on the test machine. faster storage helps because the runtime spends most of its time waiting on weight reads.<br>proof of concept, ahead of its hardware. taught me more about how weights behave than anything i've read.",
      year: "2026",
      url: "/contact?project=seance",
      slug: "seance",
      status: "parked",
    },
    {
      title: "Minecraft Server Maintainer",
      description: "A 67KB jar that lives next to your server folder. Double-click it and walk away.<br>It keeps Minecraft, mods, plugins, and datapacks current, and after every update it checks the server still boots, rolling back anything that doesn't. Crash, and it brings itself quietly back, rate-limited so it never thrashes.<br>No Docker, no web panel, no subscription.",
      image: "/images/mc-server-maintainer.webp",
      month: "January",
      year: "2026",
      url: "https://github.com/worflor/minecraft-server-maintainer",
      github: "worflor/minecraft-server-maintainer",
      slug: "minecraft-server-maintainer",
    },
    /*

    {
      title: "Interwoven",
      description: "Fabric 1.21 Mod <br>Building upon underdeveloped systems, then interweaving those back into the existing game. <br>*Peaceful mode enhancements, Bedrock Parity, Animation Tweaks, and more.*",
      image: "/images/placeholder-2.webp",
      year: "2025",
      url: identity.github,
    },
    {
      title: "Blood Moons",
      description: "Fabric 1.21 Mod <br>Blood Moons have been done before, but this one is unique.*...he claims..* <br>*From Weeping Angels, to Zeus' Wrath, each moon offers a unique experience.*",
      image: "/images/placeholder-3.webp",
      year: "2025",
      url: identity.github,
    },
    */
    {
      title: "Morithon",
      description: "Unreal Engine 5 death-run. 45 students, one semester.<br>Can you beat your friends?",
      image: "/images/morithon.webp",
      year: "2024",
      url: "https://dhafo.itch.io/morithon",
      slug: "morithon",
    },
  ],
  publications: [
    {
      title: "ϱ: The Self-Referential Fixed Point of the Complex Exponential",
      authors: "Michael Bickford",
      arxivId: "2606.01668",
      category: "math.CV",
      date: "June 2026",
      teaser:
        "The complex exponential has a unique fixed point ϱ ≈ 0.318 + 1.337i, the solution of exp(z) = z in the strip 0 < Im z < π, and the geometry that unfolds once you take it seriously.",
    },
  ],
  threads: [
    {
      motif: "i keep wandering into areas i don't know yet.",
      line: "a framework i haven't touched, some system someone built like a cathedral. i take a piece home and play with it.",
    },
    {
      motif: "i don't like math treated as rigid.",
      line: "a system needs its rules to hold, but that's what makes it fun. the rules hold. so be loose everywhere else.",
    },
    {
      motif: "i'm just a curious nerd with so many projects i ran out of disk space.",
      line: "",
    },
  ],
};

// blog
export const blogPageContent: BlogPageContent = {
  seo: {
    title: "Blog | woflo",
    description: "Thoughts, stories, and moments.",
    image: identity.logo,
  },
  subtitle: "thoughts, stories, and moments.",
};

// contact
export const contactPageContent: ContactPageContent = {
  seo: {
    title: "Contact | woflo",
    description: "Get in touch with me.",
    image: identity.logo,
  },
  subtitle: "say hi, ask a question, or just yell into the void :P",
  sentMessage: "message sent -- i'll get back to you if you left an email :)",
  placeholders: {
    name: "anonymous is fine",
    email: "your@email.com, if you want a reply",
    message: "what's on your mind?",
  },
  heyPlaceholders: {
    name: "and you are..?",
    email: "so I can get back to you",
    message: "well hello there :) what's on your mind?",
  },
};

// freelance
//
// `enabled` is the whole switch. the component checks it and renders nothing
// when it is false, so no page has to remember to guard its own call, and the
// slot cannot be half-open: on means every surface offers it, off means none do.
export const freelanceBriefContent: FreelanceBriefContent = {
  enabled: true,
  kicker: "freelance workbench",
  status: "open",
  heading: "Have a strange idea, a broken workflow, or a system that ought to exist?",
  // the leader rule above already states availability, so the sentence no
  // longer has to.
  subtitle: "I build useful things from unclear beginnings.",
  placeholder: "explain away",
  submitLabel: "send the brief",
};
