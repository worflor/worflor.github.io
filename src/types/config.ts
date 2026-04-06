export type NavBarLink = {
  title: string;
  url: string;
  external?: boolean;
};

export type GalleryImage = {
  src: string;
  alt: string;
};

export type SocialLink = {
  title: string;
  url: string;
  icon: string;
  external?: boolean;
};

export type Identity = {
  name: string;
  logo: string;
  email: string;
  github: string;
};

export type SEOInfo = {
  title: string;
  description: string;
  image: string;
};

export type HomePageContent = {
  seo: SEOInfo;
  role: string;
  description: string;
  socialLinks: SocialLink[];
  links: NavBarLink[];
};

export type ResumeItem = {
  title: string;
  company: {
    name: string;
    image: string;
    url: string;
  };
  date: string;
};

export type AboutPrinciple = {
  title: string;
  description: string;
};

export type AboutHighlight = {
  eyebrow: string;
  title: string;
  description: string;
  url: string;
  external?: boolean;
};

export type AboutPathItem = {
  era: string;
  title: string;
  description: string;
};

export type AboutPageContent = {
  seo: SEOInfo;
  subtitle: string;
  about: {
    description: string;
    images: GalleryImage[];
  };
  build: {
    description: string;
    principles: AboutPrinciple[];
  };
  highlights: {
    description: string;
    items: AboutHighlight[];
  };
  path: {
    description: string;
    items: AboutPathItem[];
  };
  connect: {
    description: string;
    links: SocialLink[];
  };
};

export type Project = {
  title: string;
  description: string;
  image: string;
  year: string;
  url: string;
  github?: string;
};

export type ProjectPageContent = {
  seo: SEOInfo;
  subtitle: string;
  projects: Project[];
};

export type BlogPageContent = {
  seo: SEOInfo;
  subtitle: string;
};

export type ContactPageContent = {
  seo: SEOInfo;
  subtitle: string;
  sentMessage: string;
  placeholders: {
    name: string;
    email: string;
    message: string;
  };
  heyPlaceholders: {
    name: string;
    email: string;
    message: string;
  };
};
