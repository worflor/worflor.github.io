FROM node:lts-alpine AS runtime
WORKDIR /app

COPY . .

RUN npm ci
RUN npm run build

# Install a lightweight static file server
RUN npm install -g serve

ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321
CMD serve dist -l 4321
