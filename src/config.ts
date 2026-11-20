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
      "Michael Bickford makes software, games, and Minecraft projects, and tinkers with math in his spare time.",
    image: identity.logo,
  },
  role: "Software developer & game maker",
  description:
    "I make software, games, and the occasional Minecraft datapack. I do research in my spare time, usually because a small question refused to stay small.",
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
      "About Michael Bickford, a Canadian software developer and game maker.",
    image: identity.logo,
  },
  subtitle: "hey, let's get to know each other.",
  about: {
    description: `
I'm Michael, a software developer and game maker from Canada. I came to game development through theatre and teaching, then wandered into modding, developer tools, and math.
<br/><br/>
I like making small things feel right: a brushstroke that moves like it's thinking, or a Minecraft card that feels like something you could actually pick up.`,
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
    description: `I started with **C++** and shaders. These days I use whatever fits: **Rust** for Neuron, **Java** for Minecraft, and a bit of everything else as needed.`,
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
      "Tools, games, and Minecraft projects you can try, plus a few things I'm still working on.",
    image: identity.logo,
  },
  subtitle: "Things I’ve made, and a few I’m still figuring out.",
  projects: [
    {
      title: "Neuron",
      description:
        "My Rust alternative to Razer Synapse for Windows, with reactive lighting, button remapping, and macros. I use it daily on my Naga V2 Pro and BlackWidow Chroma V2. No account or cloud.",
      image: "/images/neuron-portfolio-color.webp",
      month: "July",
      year: "2026",
      url: "/neuron",
      slug: "neuron",
      github: "worflor/neuron",
      trackRelease: true,
    },
    {
      title: "all you mean to me",
      description: "A short, wordless museum game. You’re a wet brushstroke that can step into paintings and hold parts of them still. Play in your browser on itch.io.",
      image: "/images/all-you-mean-to-me.webp",
      month: "November",
      year: "2026",
      url: "https://woflo.itch.io/all-you-mean-to-me",
      slug: "all-you-mean-to-me",
    },
    {
      title: "Tabletop Tarot",
      description: "A vanilla Minecraft datapack with illustrated cards you can shuffle, deal, and lay out on a table in your world.",
      image: "/images/tabletop-tarot.webp",
      month: "November",
      year: "2026",
      url: "https://modrinth.com/datapack/tarot-packs",
      slug: "tabletop-tarot",
      modrinth: "tarot-packs",
    },
    {
      title: "Manifold",
      description:
        "A desktop Git client that uses commit history to show which files tend to change together. Built with Flutter and a bit of spectral geometry.",
      image: "/images/manifold",
      month: "April",
      year: "2026",
      url: "https://github.com/worflor/git-desktop-premium-ultra-promax-plus-R",
      github: "worflor/git-desktop-premium-ultra-promax-plus-R",
      slug: "manifold",
    },
    {
      title: "Whisper",
      description: "A browser playground for encrypted messages and peer-to-peer chat. Standard cryptography protects the message; the experimental geometry is in the codec.",
      image: "/images/whisper.webp",
      month: "February",
      year: "2026",
      url: "/whisper?live",
      slug: "whisper",
      status: "playground",
    },
    {
      title: "Lore",
      description:
        "A private-first space for exploring tarot, astrology, and the stories you make with them. There’s an owl. You can give it a card.",
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
        "A tool I made for poking at math questions. It can work out exact values and look for counterexamples.",
      month: "May",
      year: "2026",
      url: "/scryer/",
      slug: "scryer",
      status: "active-research",
    },
    {
      title: "Engram",
      description: "A mathematical experiment in motion and memory. It predicts the brushstroke’s movement in all you mean to me and helps shape how the character reacts.",
      month: "October",
      year: "2026",
      url: "https://github.com/worflor/engram",
      github: "worflor/engram",
      slug: "engram",
      status: "active-research",
    },
    {
      title: "What Do You Mean?",
      description: "My college capstone: a Minecraft debugger that sets soft breakpoints in a running mod while a separate watcher keeps an eye on server tick rate. The write-up shows how the two fit together.",
      image: "/images/wdym-cover.webp",
      month: "April",
      year: "2026",
      url: "/blog/wdym",
      slug: "wdym",
    },
    {
      title: "Minecraft Server Maintainer",
      description: "A small Java tool that updates a Minecraft server, checks that it still boots, and rolls back failed updates. No Docker or web panel.",
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
      description: "An Unreal Engine 5 death-run made by 45 students in one semester.",
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
        "A paper on the solution of exp(z) = z in the strip 0 < Im z < π and the geometry around it.",
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
  placeholder: "explain away",
  submitLabel: "send the brief",
};
