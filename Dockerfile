FROM node:22-slim
WORKDIR /app
ENV PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 CI=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Tests, then the gate. Non-zero exit when the gate blocks; report.md is written to /app.
CMD ["sh", "-c", "npm test && npm run gate"]
