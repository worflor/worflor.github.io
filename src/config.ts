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
    title: "Projects",
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
      title: "My Projects",
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
        title: "Projects",
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
    title: "Projects | woflo",
    description: "Endeavours.",
    image: identity.logo,
  },
  subtitle: "some endeavours.",
  projects: [
    {
      title: "Manifold",
      description:
        "Git desktop client. Your codebase is a manifold.<br>Heat-kernel diffusion over the file graph finds what's structurally coupled to each change. Ricci curvature pinpoints the architectural bridges.<br>Flutter, Dart, and a bit of spectral geometry.",
      image: "/images/manifold",
      year: "2026",
      url: "https://github.com/worflor/git-desktop-premium-ultra-promax-plus-R",
      github: "worflor/git-desktop-premium-ultra-promax-plus-R",
    },
    {
      title: "Whisper",
      description: "Encrypted communication over Möbius geometry, entirely in the browser.<br>Hide data in images, talk peer-to-peer through a 16D spatial codec, derive shared secrets.<br>No servers, no accounts, no trace.",
      image: "/images/whisper.webp",
      year: "2026",
      url: "/whisper?live",
    },
    {
      title: "Seance",
      description: "Run any LLM straight from your SSD. The weights stay on the drive; they never load into RAM.<br>A small oscillator model tracks each layer of the network. When it can predict where the layer is going accurately enough, the heavy math gets skipped and the prediction stands in. On a 9B model that's about 96% of the layers, with output identical to running the model in full.<br>197KB of Rust and the realization that an LLM's forward pass is mostly decompression.",
      image: "/images/seance-cover.svg",
      year: "2026",
      url: "/contact?project=seance",
      status: "private-beta",
    },
    {
      title: "Wick",
      description: "Point Wick at a folder. It indexes the files, trains a semantic space on your corpus, and answers in about a millisecond.<br>Heat-kernel diffusion reads structure that flat similarity misses. Every answer comes with a posture: decisive, exploring, reaching, or flinching. When the corpus doesn't have what you're asking, the engine says so plainly.<br>One Rust binary, one SQLite file, zero downloads.",
      image: "/images/wick-cover.svg",
      year: "2026",
      url: "/contact?project=wick",
      status: "private-beta",
    },
    {
      title: "What Do You Mean?",
      description: "In-game agentic debugger for Minecraft.<br>The Doctor reads any mod's bytecode on demand, patches behavior live, sets soft breakpoints via a Condition Compiler. The Watchdog watches TPS, threads, and network in the background.<br>Fabric 1.21, college capstone 2026, full TDD and postmortem.",
      image: "/images/wdym-cover.webp",
      year: "2026",
      url: "/blog/wdym",
    },
    {
      title: "Project Pocket",
      description: "Encryption that doesn't protect the file. Encryption that decides whether the file exists.<br>Project Pocket is the witness. A public BitTorrent swarm holds the blobs; nothing in them is recognizable as data, and nothing in the swarm knows what it's holding. A Kizuna 16D witness check decides whether your handshake's geometry matches, and if it does, the blob collapses into a file your machine can read and execute. Authorized peers run WASM forward and push the next encrypted state back. There is no admin. The math is the access controller.<br>Concept paper, unreviewed code, and the open question of what breaks first.",
      year: "2026",
      url: "/contact?project=pocket",
      status: "concept",
    },
    {
      title: "Project Prisma",
      description: "Footage in superposition. Every frame holds every possible cut.<br>Prisma is the measurement. The Whisper codecs already produce a surprise signal for every byte, every sample, every frame. Read those signals as attention, weight them, collapse the timeline. The edit was always in the recording; nobody had a way to find it.<br>Concept stage. The codec measures attention. Whether that's what an editor would measure is still being worked out.",
      year: "2026",
      url: "/contact?project=prisma",
      status: "concept",
    },
    {
      title: "Minecraft Server Maintainer",
      description: "67KB Java jar. Double-click your server folder, done.<br>Auto-updates Minecraft, mods, plugins, datapacks. Verifies startup after every update. Rolls back if something breaks. Restarts on crash with rate limiting.<br>No Docker, no web panel, no subscription.",
      image: "/images/mc-server-maintainer.webp",
      year: "2026",
      url: "https://github.com/worflor/minecraft-server-maintainer",
      github: "worflor/minecraft-server-maintainer",
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
      description: "Unreal Engine 5 death-run. 45 students, one semester.<br>UI, UX, and the settings menu logic on the UI team.<br>Can you beat your friends?",
      image: "/images/morithon.webp",
      year: "2024",
      url: "https://dhafo.itch.io/morithon",
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
