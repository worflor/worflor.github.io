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
    title: "Michael Bickford",
    description:
      "Canadian Game and Technology Enthusiast who likes building cool things.",
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
    title: "About | Michael Bickford",
    description:
      "Lifetime gamer and professional picky person from Canada.",
    image: identity.logo,
  },
  subtitle: "hey, let's get to know each other.",
  about: {
    description: `
I'm Michael, a game and general technology enthusiast from Canada and I like to do stuff :]
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
    description: `To me, programming languages are tools, and I'm always picking up new ones for random purpses. Started with **C++** and Shader Languages like **GLSL**, and have since picked up **Java (21+)** and miniscule amounts of *Python (3.12)*.
    <br/>
    Why? Check out my Projects page!`,
    items: [
      {
        title: "Game Developer",
        company: {
          name: "Freelance",
          image: identity.logo,
          url: identity.github,
        },
        date: "2024 - Present",
      },
      {
        title: "Tool Maker",
        company: {
          name: "Freelance",
          image: identity.logo,
          url: identity.github,
        },
        date: "2024 - Present",
      },
    ],
  },
  connect: {
    description: ``,
    links: [
      {
        title: "Contact Me",
        url: "/contact",
        icon: "mdi:message-outline",
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
    title: "Projects | Michael Bickford",
    description: "Endeavours.",
    image: identity.logo,
  },
  subtitle: "some endeavours.",
  projects: [
    {
      title: "What Do You Mean? - Mod/Tool",
      description: "College Capstone 2026 <br>Enable real time patching in Minecraft, without breaking any existing code/systems (vanilla, datapack, or modded)",
      image: "/images/wdym-cover.webp",
      year: "2026",
      url: "/blog/wdym",
    },
    {
      title: "Interwoven",
      description: "Fabric 1.21 Mod <br>Building upon underdeveloped systems, then interweaving those back into the existing game. <br>*Peaceful mode enhancements, Bedrock Parity, Animation Tweaks, and more.*",
      image: "/images/placeholder-2.webp",
      year: "2025",
      url: identity.github,
    },
    /*
    {
      title: "Blood Moons",
      description: "Fabric 1.21 Mod <br>Blood Moons have been done before, but this one is unique.*...he claims..* <br>*From Weeping Angels, to Zeus' Wrath, each moon offers a unique experience.*",
      image: "/images/placeholder-3.webp",
      year: "2025",
      url: identity.github,
    },
    */
    {
      title: "Morithon - Game",
      description: "Unreal Engine 5.1 - Game Productions 2024 <br>A group project of 45 students in a single semester. As a member of UI team, I worked on various UI and UX elements, as well as the settings menu logic. <br><br>Can you beat your friends in a death-run?",
      image: "/images/morithon.webp",
      year: "2024",
      url: "https://dhafo.itch.io/morithon",
    },
  ],
};

// blog
export const blogPageContent: BlogPageContent = {
  seo: {
    title: "Blog | Michael Bickford",
    description: "Thoughts, stories, and moments.",
    image: identity.logo,
  },
  subtitle: "thoughts, stories, and moments.",
};

// contact
export const contactPageContent: ContactPageContent = {
  seo: {
    title: "Contact | " + identity.name,
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
