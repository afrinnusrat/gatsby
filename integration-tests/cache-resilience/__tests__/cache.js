const fs = require(`fs`)
const { spawnSync } = require(`child_process`)
const path = require(`path`)
const v8 = require(`v8`)
const _ = require(`lodash`)
const slash = require(`slash`)
const {
  ON_PRE_BOOTSTRAP_FILE_PATH,
  ON_POST_BOOTSTRAP_FILE_PATH,
} = require(`../utils/constants`)
const { createContentDigest } = require(`gatsby-core-utils`)

const sanitizePageCreatorPluginOptions = options => {
  if (options && options.path) {
    return {
      ...options,
      path: slash(path.relative(process.cwd(), options.path)),
    }
  }
  return options
}

// TODO: Make this not mutate the passed in value
const sanitiseNode = value => {
  if (value && value.internal && value.internal.contentDigest) {
    if (value.internal.type === `Site`) {
      delete value.buildTime
      delete value.internal.contentDigest
    }
    if (value.internal.type === `SitePlugin`) {
      delete value.packageJson
      delete value.internal.contentDigest
      delete value.version
      if (value.name === `gatsby-plugin-page-creator`) {
        // make id more stable
        value.id = createContentDigest(
          `${value.name}${JSON.stringify(
            sanitizePageCreatorPluginOptions(value.pluginOptions)
          )}`
        )
      }
    }
    if (value.internal.type === `SitePage`) {
      delete value.internal.contentDigest
      delete value.internal.description
      delete value.pluginCreatorId
      delete value.pluginCreator___NODE
    }
  }

  // we don't care about order of node creation at this point
  delete value.internal.counter

  // loki adds $loki metadata into nodes
  delete value.$loki

  return value
}

const getSubStateByPlugins = (state, pluginNamesArray) =>
  _.mapValues(state, stateShard => {
    const filteredMap = new Map()

    stateShard.forEach(node => {
      if (pluginNamesArray.includes(node.internal.owner)) {
        filteredMap.set(node.id, node)
      }
    })

    return filteredMap
  })

const loadState = path => {
  const state = v8.deserialize(fs.readFileSync(path))

  const sanitisedState = state.map(sanitiseNode)

  const newState = new Map()
  sanitisedState
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach(sanitisedNode => {
      newState.set(sanitisedNode.id, sanitisedNode)
    })

  return newState
}

jest.setTimeout(100000)

const gatsbyBin = path.join(
  `node_modules`,
  `gatsby`,
  `dist`,
  `bin`,
  `gatsby.js`
)

const { compareState } = require(`../utils/nodes-diff`)

const useGatsbyNode = (run = 1) => {
  const r = fs.readdirSync(`plugins`)
  r.forEach(pluginName => {
    const inputPath = path.join(`plugins`, pluginName, `gatsby-node-${run}.js`)
    if (fs.existsSync(inputPath)) {
      fs.copyFileSync(
        inputPath,
        path.join(`plugins`, pluginName, `gatsby-node.js`)
      )
    }
  })
}

const build = ({ updatePlugins } = {}) => {
  spawnSync(gatsbyBin, [`clean`])
  useGatsbyNode(1)

  let processOutput

  // First run, get state
  processOutput = spawnSync(gatsbyBin, [`build`], {
    stdio: [`inherit`, `inherit`, `inherit`, `inherit`],
    env: {
      ...process.env,
      EXIT_ON_POST_BOOTSTRAP: `1`,
      NODE_ENV: `production`,
    },
  })

  if (processOutput.status !== 0) {
    throw new Error(`Gatsby exited with non-zero code`)
  }

  const preBootstrapStateFromFirstRun = loadState(ON_PRE_BOOTSTRAP_FILE_PATH)

  const postBootstrapStateFromFirstRun = loadState(ON_POST_BOOTSTRAP_FILE_PATH)

  if (updatePlugins) {
    // Invalidations
    useGatsbyNode(2)
  }

  // Second run, get state and compare with state from previous run
  processOutput = spawnSync(gatsbyBin, [`build`], {
    stdio: [`inherit`, `inherit`, `inherit`, `inherit`],
    env: {
      ...process.env,
      EXIT_ON_POST_BOOTSTRAP: `1`,
      NODE_ENV: `production`,
    },
  })

  if (processOutput.status !== 0) {
    throw new Error(`Gatsby exited with non-zero code`)
  }

  const preBootstrapStateFromSecondRun = loadState(ON_PRE_BOOTSTRAP_FILE_PATH)

  const postBootstrapStateFromSecondRun = loadState(ON_POST_BOOTSTRAP_FILE_PATH)

  return {
    preBootstrapStateFromFirstRun,
    postBootstrapStateFromFirstRun,
    preBootstrapStateFromSecondRun,
    postBootstrapStateFromSecondRun,
  }
}

afterAll(() => {
  // go back to initial
  useGatsbyNode(1)

  // delete saved states
  if (fs.existsSync(ON_PRE_BOOTSTRAP_FILE_PATH)) {
    fs.unlinkSync(ON_PRE_BOOTSTRAP_FILE_PATH)
  }
  if (fs.existsSync(ON_POST_BOOTSTRAP_FILE_PATH)) {
    fs.unlinkSync(ON_POST_BOOTSTRAP_FILE_PATH)
  }
})

describe(`Cache`, () => {
  beforeAll(() => {
    useGatsbyNode(1)
  })

  describe(`Redux`, () => {
    it(`is persisted between builds`, () => {
      const {
        preBootstrapStateFromFirstRun,
        postBootstrapStateFromFirstRun,
        preBootstrapStateFromSecondRun,
        postBootstrapStateFromSecondRun,
      } = build({
        updatePlugins: false,
      })

      expect(preBootstrapStateFromFirstRun.size).toEqual(0)

      expect(postBootstrapStateFromFirstRun).toEqual(
        preBootstrapStateFromSecondRun
      )
      expect(postBootstrapStateFromFirstRun).toEqual(
        postBootstrapStateFromSecondRun
      )
    })

    describe.only(`Nodes`, () => {
      let states

      beforeAll(() => {
        states = build({
          updatePlugins: true,
        })
      })

      it(`sanity checks`, () => {
        // preconditions - we expect our cache to be empty on first run
        expect(states.preBootstrapStateFromFirstRun.size).toEqual(0)

        // test-dev only snapshots to see what's happening
        expect(states.postBootstrapStateFromFirstRun).toMatchSnapshot()
        expect(states.preBootstrapStateFromSecondRun).toMatchSnapshot()
        expect(states.postBootstrapStateFromSecondRun).toMatchSnapshot()
      })

      it(`are not deleted when the owner plugin does not change`, () => {
        const {
          postBootstrapStateFromFirstRun,
          preBootstrapStateFromSecondRun,
          postBootstrapStateFromSecondRun,
        } = getSubStateByPlugins(states, [`gatsby-plugin-stable`])

        const postCacheInvalidationDiff = compareState(
          postBootstrapStateFromFirstRun,
          preBootstrapStateFromSecondRun
        )

        expect(postBootstrapStateFromFirstRun).toEqual(
          preBootstrapStateFromSecondRun
        )

        expect(postCacheInvalidationDiff).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {},
            "deletions": Object {},
          }
        `)

        expect(
          compareState(
            postBootstrapStateFromFirstRun,
            postBootstrapStateFromSecondRun
          )
        ).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {},
            "deletions": Object {},
          }
        `)
      })

      it(`are deleted and recreated when owner plugin changes`, () => {
        const {
          postBootstrapStateFromFirstRun,
          preBootstrapStateFromSecondRun,
          postBootstrapStateFromSecondRun,
        } = getSubStateByPlugins(states, [`gatsby-plugin-independent-node`])

        expect(
          compareState(
            postBootstrapStateFromFirstRun,
            preBootstrapStateFromSecondRun
          )
        ).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {},
            "deletions": Object {
              "INDEPENDENT_NODE_1": Object {
                "children": Array [],
                "foo": "bar",
                "id": "INDEPENDENT_NODE_1",
                "internal": Object {
                  "contentDigest": "0",
                  "owner": "gatsby-plugin-independent-node",
                  "type": "IndependentChanging",
                },
                "parent": null,
              },
            },
          }
        `)
        expect(
          compareState(
            postBootstrapStateFromFirstRun,
            postBootstrapStateFromSecondRun
          )
        ).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {
              "INDEPENDENT_NODE_1": Object {
                "diff": "  Object {
              \\"children\\": Array [],
          -   \\"foo\\": \\"bar\\",
          +   \\"foo\\": \\"baz\\",
              \\"id\\": \\"INDEPENDENT_NODE_1\\",
              \\"internal\\": Object {
                \\"contentDigest\\": \\"0\\",
                \\"owner\\": \\"gatsby-plugin-independent-node\\",
                \\"type\\": \\"IndependentChanging\\",
              },
              \\"parent\\": null,
            }",
                "id": "INDEPENDENT_NODE_1",
                "newValue": Object {
                  "children": Array [],
                  "foo": "baz",
                  "id": "INDEPENDENT_NODE_1",
                  "internal": Object {
                    "contentDigest": "0",
                    "owner": "gatsby-plugin-independent-node",
                    "type": "IndependentChanging",
                  },
                  "parent": null,
                },
                "oldValue": Object {
                  "children": Array [],
                  "foo": "bar",
                  "id": "INDEPENDENT_NODE_1",
                  "internal": Object {
                    "contentDigest": "0",
                    "owner": "gatsby-plugin-independent-node",
                    "type": "IndependentChanging",
                  },
                  "parent": null,
                },
              },
            },
            "deletions": Object {},
          }
        `)
      })

      it(`are deleted and recreated when the owner plugin of a parent changes`, () => {
        const {
          postBootstrapStateFromFirstRun,
          preBootstrapStateFromSecondRun,
          postBootstrapStateFromSecondRun,
        } = getSubStateByPlugins(states, [
          `gatsby-source-parent-change-for-transformer`,
          `gatsby-transformer-parent-change`,
        ])

        expect(
          compareState(
            postBootstrapStateFromFirstRun,
            preBootstrapStateFromSecondRun
          )
        ).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {},
            "deletions": Object {
              "2131d29a-296c-5f73-affc-e422bec644fe": Object {
                "bar": undefined,
                "children": Array [],
                "foo": "run-1",
                "id": "2131d29a-296c-5f73-affc-e422bec644fe",
                "internal": Object {
                  "contentDigest": "cbc07ead8c18c9d616f0004a893d5cf3",
                  "owner": "gatsby-transformer-parent-change",
                  "type": "ChildOfParent_ParentChangeForTransformer",
                },
                "parent": "parent_parentChangeForTransformer",
              },
              "parent_parentChangeForTransformer": Object {
                "children": Array [
                  "2131d29a-296c-5f73-affc-e422bec644fe",
                ],
                "foo": "run-1",
                "id": "parent_parentChangeForTransformer",
                "internal": Object {
                  "contentDigest": "a032c69550f5567021eda97cc3a1faf2",
                  "owner": "gatsby-source-parent-change-for-transformer",
                  "type": "Parent_ParentChangeForTransformer",
                },
                "parent": null,
              },
            },
          }
        `)

        expect(
          compareState(
            postBootstrapStateFromFirstRun,
            postBootstrapStateFromSecondRun
          )
        ).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {
              "2131d29a-296c-5f73-affc-e422bec644fe": Object {
                "diff": "  Object {
          -   \\"bar\\": undefined,
          +   \\"bar\\": \\"run-2\\",
              \\"children\\": Array [],
          -   \\"foo\\": \\"run-1\\",
          +   \\"foo\\": undefined,
              \\"id\\": \\"2131d29a-296c-5f73-affc-e422bec644fe\\",
              \\"internal\\": Object {
          -     \\"contentDigest\\": \\"cbc07ead8c18c9d616f0004a893d5cf3\\",
          +     \\"contentDigest\\": \\"a33e2263d5a5f42473e111fb400cef3d\\",
                \\"owner\\": \\"gatsby-transformer-parent-change\\",
                \\"type\\": \\"ChildOfParent_ParentChangeForTransformer\\",
              },
              \\"parent\\": \\"parent_parentChangeForTransformer\\",
            }",
                "id": "2131d29a-296c-5f73-affc-e422bec644fe",
                "newValue": Object {
                  "bar": "run-2",
                  "children": Array [],
                  "foo": undefined,
                  "id": "2131d29a-296c-5f73-affc-e422bec644fe",
                  "internal": Object {
                    "contentDigest": "a33e2263d5a5f42473e111fb400cef3d",
                    "owner": "gatsby-transformer-parent-change",
                    "type": "ChildOfParent_ParentChangeForTransformer",
                  },
                  "parent": "parent_parentChangeForTransformer",
                },
                "oldValue": Object {
                  "bar": undefined,
                  "children": Array [],
                  "foo": "run-1",
                  "id": "2131d29a-296c-5f73-affc-e422bec644fe",
                  "internal": Object {
                    "contentDigest": "cbc07ead8c18c9d616f0004a893d5cf3",
                    "owner": "gatsby-transformer-parent-change",
                    "type": "ChildOfParent_ParentChangeForTransformer",
                  },
                  "parent": "parent_parentChangeForTransformer",
                },
              },
              "parent_parentChangeForTransformer": Object {
                "diff": "  Object {
          +   \\"bar\\": \\"run-2\\",
              \\"children\\": Array [
                \\"2131d29a-296c-5f73-affc-e422bec644fe\\",
              ],
          -   \\"foo\\": \\"run-1\\",
              \\"id\\": \\"parent_parentChangeForTransformer\\",
              \\"internal\\": Object {
          -     \\"contentDigest\\": \\"a032c69550f5567021eda97cc3a1faf2\\",
          +     \\"contentDigest\\": \\"4a6a70b2f8849535de50f47c609006fe\\",
                \\"owner\\": \\"gatsby-source-parent-change-for-transformer\\",
                \\"type\\": \\"Parent_ParentChangeForTransformer\\",
              },
              \\"parent\\": null,
            }",
                "id": "parent_parentChangeForTransformer",
                "newValue": Object {
                  "bar": "run-2",
                  "children": Array [
                    "2131d29a-296c-5f73-affc-e422bec644fe",
                  ],
                  "id": "parent_parentChangeForTransformer",
                  "internal": Object {
                    "contentDigest": "4a6a70b2f8849535de50f47c609006fe",
                    "owner": "gatsby-source-parent-change-for-transformer",
                    "type": "Parent_ParentChangeForTransformer",
                  },
                  "parent": null,
                },
                "oldValue": Object {
                  "children": Array [
                    "2131d29a-296c-5f73-affc-e422bec644fe",
                  ],
                  "foo": "run-1",
                  "id": "parent_parentChangeForTransformer",
                  "internal": Object {
                    "contentDigest": "a032c69550f5567021eda97cc3a1faf2",
                    "owner": "gatsby-source-parent-change-for-transformer",
                    "type": "Parent_ParentChangeForTransformer",
                  },
                  "parent": null,
                },
              },
            },
            "deletions": Object {},
          }
        `)
      })

      it(`are deleted and recreated when the owner plugin of a child changes`, () => {
        const {
          postBootstrapStateFromFirstRun,
          preBootstrapStateFromSecondRun,
          postBootstrapStateFromSecondRun,
        } = getSubStateByPlugins(states, [
          `gatsby-source-child-change-for-transformer`,
          `gatsby-transformer-child-change`,
        ])

        expect(
          compareState(
            postBootstrapStateFromFirstRun,
            preBootstrapStateFromSecondRun
          )
        ).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {
              "parent_childChangeForTransformer": Object {
                "diff": "  Object {
          -   \\"children\\": Array [
          -     \\"3b0c942e-b51f-587b-b37d-b36c5e9af8fa\\",
          -   ],
          +   \\"children\\": Array [],
              \\"foo\\": \\"run-1\\",
              \\"id\\": \\"parent_childChangeForTransformer\\",
              \\"internal\\": Object {
                \\"contentDigest\\": \\"25f73a6d69ce857a76e0a2cdbc186975\\",
                \\"owner\\": \\"gatsby-source-child-change-for-transformer\\",
                \\"type\\": \\"Parent_ChildChangeForTransformer\\",
              },
              \\"parent\\": null,
            }",
                "id": "parent_childChangeForTransformer",
                "newValue": Object {
                  "children": Array [],
                  "foo": "run-1",
                  "id": "parent_childChangeForTransformer",
                  "internal": Object {
                    "contentDigest": "25f73a6d69ce857a76e0a2cdbc186975",
                    "owner": "gatsby-source-child-change-for-transformer",
                    "type": "Parent_ChildChangeForTransformer",
                  },
                  "parent": null,
                },
                "oldValue": Object {
                  "children": Array [
                    "3b0c942e-b51f-587b-b37d-b36c5e9af8fa",
                  ],
                  "foo": "run-1",
                  "id": "parent_childChangeForTransformer",
                  "internal": Object {
                    "contentDigest": "25f73a6d69ce857a76e0a2cdbc186975",
                    "owner": "gatsby-source-child-change-for-transformer",
                    "type": "Parent_ChildChangeForTransformer",
                  },
                  "parent": null,
                },
              },
            },
            "deletions": Object {
              "3b0c942e-b51f-587b-b37d-b36c5e9af8fa": Object {
                "children": Array [],
                "foo": "bar",
                "id": "3b0c942e-b51f-587b-b37d-b36c5e9af8fa",
                "internal": Object {
                  "contentDigest": "59b3a74325cbf2001bc21eb662f1e297",
                  "owner": "gatsby-transformer-child-change",
                  "type": "ChildOfParent_ChildChangeForTransformer",
                },
                "parent": "parent_childChangeForTransformer",
              },
            },
          }
        `)

        expect(
          compareState(
            postBootstrapStateFromFirstRun,
            postBootstrapStateFromSecondRun
          )
        ).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {
              "3b0c942e-b51f-587b-b37d-b36c5e9af8fa": Object {
                "diff": "  Object {
              \\"children\\": Array [],
          -   \\"foo\\": \\"bar\\",
          +   \\"foo\\": \\"baz\\",
              \\"id\\": \\"3b0c942e-b51f-587b-b37d-b36c5e9af8fa\\",
              \\"internal\\": Object {
          -     \\"contentDigest\\": \\"59b3a74325cbf2001bc21eb662f1e297\\",
          +     \\"contentDigest\\": \\"3bca2830e09b3c30b3ca76dccdaf5e8b\\",
                \\"owner\\": \\"gatsby-transformer-child-change\\",
                \\"type\\": \\"ChildOfParent_ChildChangeForTransformer\\",
              },
              \\"parent\\": \\"parent_childChangeForTransformer\\",
            }",
                "id": "3b0c942e-b51f-587b-b37d-b36c5e9af8fa",
                "newValue": Object {
                  "children": Array [],
                  "foo": "baz",
                  "id": "3b0c942e-b51f-587b-b37d-b36c5e9af8fa",
                  "internal": Object {
                    "contentDigest": "3bca2830e09b3c30b3ca76dccdaf5e8b",
                    "owner": "gatsby-transformer-child-change",
                    "type": "ChildOfParent_ChildChangeForTransformer",
                  },
                  "parent": "parent_childChangeForTransformer",
                },
                "oldValue": Object {
                  "children": Array [],
                  "foo": "bar",
                  "id": "3b0c942e-b51f-587b-b37d-b36c5e9af8fa",
                  "internal": Object {
                    "contentDigest": "59b3a74325cbf2001bc21eb662f1e297",
                    "owner": "gatsby-transformer-child-change",
                    "type": "ChildOfParent_ChildChangeForTransformer",
                  },
                  "parent": "parent_childChangeForTransformer",
                },
              },
            },
            "deletions": Object {},
          }
        `)
      })

      it(`to be named`, () => {
        const {
          postBootstrapStateFromFirstRun,
          preBootstrapStateFromSecondRun,
          postBootstrapStateFromSecondRun,
        } = getSubStateByPlugins(states, [
          `gatsby-source-parent-change-for-fields`,
          `gatsby-fields-parent-change`,
        ])

        expect(
          compareState(
            postBootstrapStateFromFirstRun,
            preBootstrapStateFromSecondRun
          )
        ).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {},
            "deletions": Object {
              "parent_parentChangeForFields": Object {
                "children": Array [],
                "fields": Object {
                  "bar": undefined,
                  "foo": "run-1",
                },
                "foo": "run-1",
                "id": "parent_parentChangeForFields",
                "internal": Object {
                  "contentDigest": "ad237cf525f0ccb39ea0ba07165d4119",
                  "fieldOwners": Object {
                    "bar": "gatsby-fields-parent-change",
                    "foo": "gatsby-fields-parent-change",
                  },
                  "owner": "gatsby-source-parent-change-for-fields",
                  "type": "Parent_ParentChangeForFields",
                },
                "parent": null,
              },
            },
          }
        `)

        expect(
          compareState(
            postBootstrapStateFromFirstRun,
            postBootstrapStateFromSecondRun
          )
        ).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {
              "parent_parentChangeForFields": Object {
                "diff": "  Object {
          +   \\"bar\\": \\"run-2\\",
              \\"children\\": Array [],
              \\"fields\\": Object {
          -     \\"bar\\": undefined,
          -     \\"foo\\": \\"run-1\\",
          +     \\"bar\\": \\"run-2\\",
          +     \\"foo\\": undefined,
              },
          -   \\"foo\\": \\"run-1\\",
              \\"id\\": \\"parent_parentChangeForFields\\",
              \\"internal\\": Object {
          -     \\"contentDigest\\": \\"ad237cf525f0ccb39ea0ba07165d4119\\",
          +     \\"contentDigest\\": \\"72122def77d239ba36e9b9729fc53adf\\",
                \\"fieldOwners\\": Object {
                  \\"bar\\": \\"gatsby-fields-parent-change\\",
                  \\"foo\\": \\"gatsby-fields-parent-change\\",
                },
                \\"owner\\": \\"gatsby-source-parent-change-for-fields\\",
                \\"type\\": \\"Parent_ParentChangeForFields\\",
              },
              \\"parent\\": null,
            }",
                "id": "parent_parentChangeForFields",
                "newValue": Object {
                  "bar": "run-2",
                  "children": Array [],
                  "fields": Object {
                    "bar": "run-2",
                    "foo": undefined,
                  },
                  "id": "parent_parentChangeForFields",
                  "internal": Object {
                    "contentDigest": "72122def77d239ba36e9b9729fc53adf",
                    "fieldOwners": Object {
                      "bar": "gatsby-fields-parent-change",
                      "foo": "gatsby-fields-parent-change",
                    },
                    "owner": "gatsby-source-parent-change-for-fields",
                    "type": "Parent_ParentChangeForFields",
                  },
                  "parent": null,
                },
                "oldValue": Object {
                  "children": Array [],
                  "fields": Object {
                    "bar": undefined,
                    "foo": "run-1",
                  },
                  "foo": "run-1",
                  "id": "parent_parentChangeForFields",
                  "internal": Object {
                    "contentDigest": "ad237cf525f0ccb39ea0ba07165d4119",
                    "fieldOwners": Object {
                      "bar": "gatsby-fields-parent-change",
                      "foo": "gatsby-fields-parent-change",
                    },
                    "owner": "gatsby-source-parent-change-for-fields",
                    "type": "Parent_ParentChangeForFields",
                  },
                  "parent": null,
                },
              },
            },
            "deletions": Object {},
          }
        `)
      })

      it(`to be named #2`, () => {
        const {
          postBootstrapStateFromFirstRun,
          preBootstrapStateFromSecondRun,
          postBootstrapStateFromSecondRun,
        } = getSubStateByPlugins(states, [
          `gatsby-source-child-change-for-fields`,
          `gatsby-fields-child-change`,
        ])

        expect(
          compareState(
            postBootstrapStateFromFirstRun,
            preBootstrapStateFromSecondRun
          )
        ).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {
              "parent_childChangeForFields": Object {
                "diff": "  Object {
              \\"children\\": Array [],
          -   \\"fields\\": Object {
          -     \\"foo1\\": \\"bar\\",
          -   },
          +   \\"fields\\": Object {},
              \\"foo\\": \\"run-1\\",
              \\"id\\": \\"parent_childChangeForFields\\",
              \\"internal\\": Object {
                \\"contentDigest\\": \\"893740bfde4b8a6039e939cb0290d626\\",
          -     \\"fieldOwners\\": Object {
          -       \\"foo1\\": \\"gatsby-fields-child-change\\",
          -     },
          +     \\"fieldOwners\\": Object {},
                \\"owner\\": \\"gatsby-source-child-change-for-fields\\",
                \\"type\\": \\"Parent_ChildChangeForFields\\",
              },
              \\"parent\\": null,
            }",
                "id": "parent_childChangeForFields",
                "newValue": Object {
                  "children": Array [],
                  "fields": Object {},
                  "foo": "run-1",
                  "id": "parent_childChangeForFields",
                  "internal": Object {
                    "contentDigest": "893740bfde4b8a6039e939cb0290d626",
                    "fieldOwners": Object {},
                    "owner": "gatsby-source-child-change-for-fields",
                    "type": "Parent_ChildChangeForFields",
                  },
                  "parent": null,
                },
                "oldValue": Object {
                  "children": Array [],
                  "fields": Object {
                    "foo1": "bar",
                  },
                  "foo": "run-1",
                  "id": "parent_childChangeForFields",
                  "internal": Object {
                    "contentDigest": "893740bfde4b8a6039e939cb0290d626",
                    "fieldOwners": Object {
                      "foo1": "gatsby-fields-child-change",
                    },
                    "owner": "gatsby-source-child-change-for-fields",
                    "type": "Parent_ChildChangeForFields",
                  },
                  "parent": null,
                },
              },
            },
            "deletions": Object {},
          }
        `)

        expect(
          compareState(
            postBootstrapStateFromFirstRun,
            postBootstrapStateFromSecondRun
          )
        ).toMatchInlineSnapshot(`
          Object {
            "additions": Object {},
            "changes": Object {
              "parent_childChangeForFields": Object {
                "diff": "  Object {
              \\"children\\": Array [],
              \\"fields\\": Object {
          -     \\"foo1\\": \\"bar\\",
          +     \\"foo2\\": \\"baz\\",
              },
              \\"foo\\": \\"run-1\\",
              \\"id\\": \\"parent_childChangeForFields\\",
              \\"internal\\": Object {
                \\"contentDigest\\": \\"893740bfde4b8a6039e939cb0290d626\\",
                \\"fieldOwners\\": Object {
          -       \\"foo1\\": \\"gatsby-fields-child-change\\",
          +       \\"foo2\\": \\"gatsby-fields-child-change\\",
                },
                \\"owner\\": \\"gatsby-source-child-change-for-fields\\",
                \\"type\\": \\"Parent_ChildChangeForFields\\",
              },
              \\"parent\\": null,
            }",
                "id": "parent_childChangeForFields",
                "newValue": Object {
                  "children": Array [],
                  "fields": Object {
                    "foo2": "baz",
                  },
                  "foo": "run-1",
                  "id": "parent_childChangeForFields",
                  "internal": Object {
                    "contentDigest": "893740bfde4b8a6039e939cb0290d626",
                    "fieldOwners": Object {
                      "foo2": "gatsby-fields-child-change",
                    },
                    "owner": "gatsby-source-child-change-for-fields",
                    "type": "Parent_ChildChangeForFields",
                  },
                  "parent": null,
                },
                "oldValue": Object {
                  "children": Array [],
                  "fields": Object {
                    "foo1": "bar",
                  },
                  "foo": "run-1",
                  "id": "parent_childChangeForFields",
                  "internal": Object {
                    "contentDigest": "893740bfde4b8a6039e939cb0290d626",
                    "fieldOwners": Object {
                      "foo1": "gatsby-fields-child-change",
                    },
                    "owner": "gatsby-source-child-change-for-fields",
                    "type": "Parent_ChildChangeForFields",
                  },
                  "parent": null,
                },
              },
            },
            "deletions": Object {},
          }
        `)
      })
    })

    describe(`Fields`, () => {
      it.todo(`are deleted and recreated when owner plugin changes`)
    })
  })
  describe(`Disk`, () => {})
})
