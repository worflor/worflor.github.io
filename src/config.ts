import type {
  NavBarLink,
  SocialLink,
  Identity,
  AboutPageContent,
  ProjectPageContent,
  BlogPageContent,
  HomePageContent,
  ContactPageContent,
} from "./types/config";

export const identity: Identity = {
  name: "Michael Bickford",
  logo: "/images/logo.webp",
  email: "wofloemail@gmail.com",
  github: "https://github.com/worflor",
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
      "Canadian game and technology enthusiast who likes building cool things. I fixate on little details and tinker with computers.",
    image: identity.logo,
  },
  role: "Game & Software Developer",
  description:
    "I'm Michael, a game and general technology enthusiast who fixates on little details. Tinkering with computers since I had access to my very first one, and I plan on continuing to do so. I love tech, it's cool as hell; even when it scares me.",
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
      "Lifetime gamer and professional picky person from Canada. I like to do things ;]",
    image: identity.logo,
  },
  subtitle: "hey, let's get to know each other.",
  about: {
    description: `
I'm Michael, a game and general technology enthusiast from Canada and I like to do things ;]
<br/><br/>
Through the miracle of Osmosis, I've picked up a few things along my journey. From Theatre and Teaching (2019-2023), to Game Development (2023-present) with dabbles in general software development, game modding, networking, and more. 
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
    description: `To me, programming languages are tools, and I'm always picking up new ones for random purposes. Started with **C++** and Shader Languages like **GLSL**, and have since picked up **Java (21+)** and miniscule amounts of *Python (3.12)*.
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
        summary: "Small software, dev tools, systems experiments, and utility projects that are fast, low-latency, and, in my biased opinion, annoyingly correct.",
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
      image: "/images/neuron-cover.svg",
      month: "July",
      year: "2026",
      url: "/neuron",
      slug: "neuron",
      // the badge answers to the repository, not to this file. while it is
      // private the card says "coming soon" on its own; the day it opens the
      // badge clears itself and this line can go.
      gate: "worflor/neuron",
    },
    {
      title: "Manifold",
      description:
        "Git desktop client. Your codebase is a manifold.<br>Change one file and it shows you everything quietly bound to it, heat spreading outward through the file graph. The curvature of that graph even marks the bridges your architecture leans on.<br>Flutter, Dart, and a bit of spectral geometry.",
      image: "/images/manifold",
      month: "April",
      year: "2026",
      url: "https://github.com/worflor/git-desktop-premium-ultra-promax-plus-R",
      github: "worflor/git-desktop-premium-ultra-promax-plus-R",
      slug: "manifold",
    },
    {
      title: "Whisper",
      description: "Encrypted communication over Möbius geometry, entirely in the browser.<br>Tuck a message inside an ordinary file, or open a peer-to-peer channel through a 16D bond codec that hands both sides the same secret.<br>Mathematically private.",
      image: "/images/whisper.webp",
      month: "February",
      year: "2026",
      url: "/whisper?live",
      slug: "whisper",
    },
    {
      title: "alpha-math",
      description:
        "AlphaFold, but for algebra.<br>Hand it any algebra and it uncovers the laws it obeys, including ones nobody had written down, then proves each one exactly.",
      month: "May",
      year: "2026",
      url: "/contact?project=alpha-math",
      slug: "alpha-math",
      status: "closed-dev-alpha",
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
      description: "Encryption that doesn't protect the file. Encryption that decides whether the file exists.<br>A public BitTorrent swarm holds the blobs; nothing in them is recognizable as data. A Kizuna 16D witness check decides whether your handshake's geometry matches, and if it does, the blob collapses into a file your machine can read.",
      year: "2026",
      url: "/contact?project=pocket",
      // linked as "pocket" long before this field existed, and a slug derived
      // from the title would silently become "project-pocket" and break it.
      slug: "pocket",
      status: "concept",
    },
    {
      title: "hindsight",
      description: "hindsight is 20/20, and your gameplay just got clipped in 4K.<br>Vulkan lifts each frame off the swapchain and Lumen folds them into one continuous light field. All the while, Glyph is reading your hands as 7D kinetic strokes, so the way you played is baked into the recording as an eigenidentity.",
      year: "2026",
      url: "/contact?project=hindsight",
      slug: "hindsight",
      // "closed dev alpha" implied someone was at the wheel, and nobody has
      // been for months. parked says the true thing: built to the edge of an
      // idea and set down, still worth looking at. it lands in the concepts
      // rail on its own, so the old group override is gone.
      status: "parked",
    },
    {
      title: "Project Prisma",
      description: "Footage in superposition. Every frame holds every possible cut.<br>Prisma is the measurement. The Whisper codecs already produce a surprise signal for every byte, every sample, every frame. Read those signals as attention, weight them, collapse the timeline. The edit was always in the recording; nobody had a way to find it.",
      year: "2026",
      url: "/contact?project=prisma",
      slug: "prisma",
      status: "concept",
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
  artifacts: [
    {
      title: "Wick & Séance",
      subtitle: "two sides of the same coin.",
      takeaway:
        "wick is a corpusless corpus; séance reads a model's raw weights like one. two takes on the same heresy: cold weights, cold corpus; hot math, hot attention. and they raised each other.",
      parts: [
        {
          name: "wick",
          motion: "condense",
          blurb:
            "point it at a folder, ask, and back comes a focused packet of *your own* passages, each tagged with why it's there. one SQLite file, no embedding server, no GPU, no model download. it trains the semantic space on your corpus and runs heat-kernel diffusion over the document graph (math from the 1800s), so it reads structure flat embeddings miss, and it'll even tell you what's *missing*. ~1ms warm.",
          status: "real and running, paused at “works, not yet right” while i chase the piece it's still missing",
        },
        {
          name: "séance",
          motion: "stream",
          blurb:
            "run any LLM straight off cold SSD. no GPU, no framework, zero weights in RAM. a 197KB rust binary memory-maps the weights and reads them one matmul at a time, so a 9B model (19GB on disk) runs in under 2MB of RAM, across 12 models and 10 architecture families. it's IO-bound today (~0.5–14 tok/s), but speed scales *linearly* with drive bandwidth: no diminishing returns, no cliff. a RAM runtime goes “fast → doesn't run” the moment a model outgrows memory; séance goes “fast → a bit slower.” push compute closer to storage and it laps the traditional runtimes.",
          status: "proof of concept, ahead of its hardware. taught me more about how weights behave than anything i've read",
        },
      ],
      duality:
        "séance turns weights into a readable corpus, which is exactly the thing wick pretends to have. each one's question was the other's answer.",
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
