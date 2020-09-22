FROM node:12

RUN apt-get --yes --force-yes update && \
    apt-get --yes --force-yes install apt-file && \
    apt-file update && \
    apt-get --yes --force-yes install vim

WORKDIR /app
COPY package.json /app
RUN npm install
COPY . /app
CMD node src/main/Main.js