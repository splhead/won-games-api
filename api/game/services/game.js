'use strict';

/**
 * Read the documentation (https://strapi.io/documentation/v3.x/concepts/services.html#core-services)
 * to customize this service
 */
const axios = require('axios')
const slugify = require('slugify')
const qs = require('querystring')

function Exception(e) {
  return { e, data: e.data && e.data.errors && e.data.errors }
}

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getGameInfo(slug) {
  try {
    const { JSDOM } = require('jsdom')

    const body = await axios.get(`https://www.gog.com/game/${slug}`)
    const dom = new JSDOM(body.data)

    const description = dom.window.document.querySelector('.description')

    return {
      short_description: description.textContent.trim().slice(0, 160),
      description: description.innerHTML
    }
  } catch (e) {
    console.log("getGameInfo", Exception(e));
  }
}

async function getByName(name, entityName) {
  return strapi.services[entityName].findOne({ name })
}

function transformToObject(name) {
  return {
    name,
    slug: slugify(name, { strict: true, lower: true })
  }
}

async function create(object, entityName) {
  const item = await getByName(object.name, entityName)

  if (!item) {
    await strapi.services[entityName].create({
      name: object.name,
      slug: object.slug
    })
  }
}

async function createManyToManyData(products) {
  const developers = [];
  const publishers = [];
  const categories = [];
  const platforms = [];

  products.forEach((product) => {

    const { developers: developersPerGame, publishers: publishersPerGame, genres, operatingSystems } = product;

    developersPerGame &&
    developersPerGame.forEach((developer) => {
        developers.push(transformToObject(developer))
      })

    publishersPerGame &&
    publishersPerGame.forEach((publisher) => {
      publishers.push(transformToObject(publisher))
    })

    genres &&
      genres.forEach((item) => {
        categories.push(item)
      });

    operatingSystems &&
      operatingSystems.forEach((item) => {
        platforms.push(transformToObject(item))
      });
  });

  return Promise.all([
    ...developers.map((object) => create(object, "developer")),
    ...publishers.map((object) => create(object, "publisher")),
    ...categories.map((object) => create(object, "category")),
    ...platforms.map((object) => create(object, "platform")),
  ]);
}

async function setImage({ image, game, field = "cover" }) {
  try {
    let url = image
    if (field === 'gallery') {
      url = image.replace('_{formatter}', '')
    }
    const { data } = await axios.get(url, { responseType: "arraybuffer" });
    const buffer = Buffer.from(data, "base64");

    const FormData = require("form-data");
    const formData = new FormData();

    formData.append("refId", game.id);
    formData.append("ref", "game");
    formData.append("field", field);
    formData.append("files", buffer, { filename: `${game.slug}.jpg` });

    console.info(`Uploading ${field} image: ${game.slug}.jpg`);

    await axios({
      method: "POST",
      url: `http://${strapi.config.host}:${strapi.config.port}/upload`,
      data: formData,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${formData._boundary}`,
      },
    });
  } catch (error) {
    console.log("setImage", game.slug, Exception(e));
  }
}

async function createGames(products) {
  await Promise.all(
    products.map(async (product) => {
      const item = await getByName(product.title, "game");

      if (!item) {
        console.info(`Creating: ${product.title}...`);

        const game = await strapi.services.game.create({
          name: product.title,
          slug: product.slug.replace(/-/g, "_"),
          price: Number(product.price.finalMoney.amount),
          release_date: new Date(
            product.releaseDate
          ).toISOString(),
          categories: await Promise.all(
            product.genres.map((item) => getByName(item.name, "category"))
          ),
          platforms: await Promise.all(
            product.operatingSystems.map((name) =>
              getByName(name, "platform")
            )
          ),
          developers: await Promise.all(
            product.developers.map((name) =>
              getByName(name, "developer")
            )
          ),
          publishers: await Promise.all(
            product.publishers.map((name) =>
              getByName(name, "publisher")
            )
          ),
          ...(await getGameInfo(product.slug.replace(/-/g, "_"))),
        });

        await setImage({ image: product.coverHorizontal, game });
        await Promise.all(
          product.screenshots
            .slice(0, 5)
            .map((url) => {
              setImage({ image: url, game, field: "gallery" })
            })
        );

        await timeout(2000);

        return game;
      }
    })
  );
}

module.exports = {
  populate: async (params) => {
    try {
      // const gogApiUrl =
      // `https://www.gog.com/games/ajax/filtered?mediaType=game&${qs.stringify(
      //   params
      // )}`
      const gogApiUrl =
      `https://catalog.gog.com/v1/catalog?${qs.stringify(
        params
      )}`

      const {
        data: { products },
      } = await axios.get(gogApiUrl)

      console.log(products[0])

      await createManyToManyData(products);
      await createGames(products);
    } catch (e) {
      console.log("populate", Exception(e));
    }
  },
};
