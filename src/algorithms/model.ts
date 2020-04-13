import {
  ModelParams,
  SimulationTimePoint,
  InternalCurrentData,
  InternalCumulativeData,
  UserResult,
  ExportedTimePoint,
} from './types/Result.types'

import { msPerDay } from './initialize'

const eulerStep = 0.5
export const eulerStepsPerDay = Math.round(1 / eulerStep)

interface StateFlux {
  susceptible: number[]
  exposed: number[][]
  infectious: {
    severe: number[]
    recovered: number[]
  }
  severe: {
    critical: number[]
    recovered: number[]
  }
  critical: {
    severe: number[]
    fatality: number[]
  }
  overflow: {
    severe: number[]
    fatality: number[]
  }
}

export function evolve(
  pop: SimulationTimePoint,
  P: ModelParams,
  tMax: number,
  sample: (x: number) => number,
): SimulationTimePoint {
  const dT: number = tMax - pop.time
  const nSteps: number = Math.max(1, Math.round(dT / eulerStep))
  const dt = dT / nSteps
  let currState = pop
  for (let i = 0; i < nSteps; i++) {
    currState = stepODE(currState, P, dt)
  }
  return currState
}

interface TimeDerivative {
  current: InternalCurrentData
  cumulative: InternalCumulativeData
}

// NOTE: Assumes all subfields corresponding to populations have the same set of keys
function stepODE(pop: SimulationTimePoint, P: ModelParams, dt: number): SimulationTimePoint {
  const t0 = new Date(pop.time)
  const t1 = new Date(pop.time + (dt / 2) * msPerDay)
  const t2 = new Date(pop.time + dt * msPerDay)

  const k1 = derivative(fluxes(t0, pop, P))
  const k2 = derivative(fluxes(t1, advanceState(pop, k1, dt / 2, P.ICUBeds), P))
  const k3 = derivative(fluxes(t1, advanceState(pop, k2, dt / 2, P.ICUBeds), P))
  const k4 = derivative(fluxes(t2, advanceState(pop, k3, dt, P.ICUBeds), P))

  const tdot = sumDerivatives([k1, k2, k3, k4], [1 / 6, 1 / 3, 1 / 3, 1 / 6])

  const state = advanceState(pop, tdot, dt, P.ICUBeds)
  state.time = t2.valueOf()

  return state
}

function advanceState(
  pop: SimulationTimePoint,
  tdot: TimeDerivative,
  dt: number,
  nICUBeds: number,
): SimulationTimePoint {
  const newPop: SimulationTimePoint = {
    time: Date.now(),
    current: {
      susceptible: [],
      exposed: [],
      infectious: [],
      severe: [],
      critical: [],
      overflow: [],
    },
    cumulative: {
      recovered: [],
      hospitalized: [],
      critical: [],
      fatality: [],
    },
  }

  // Helper functions
  const sum = (arr: number[]): number => {
    return arr.reduce((a, b) => a + b, 0)
  }

  const gz = (x: number): number => {
    return x > 0 ? x : 0
  }

  // TODO(nnoll): Sort out types
  const update = (age, kind, compartment) => {
    newPop[kind][compartment][age] = gz(pop[kind][compartment][age] + dt * tdot[kind][compartment][age])
  }

  const updateAt = (age, kind, compartment, i) => {
    newPop[kind][compartment][age][i] = gz(pop[kind][compartment][age][i] + dt * tdot[kind][compartment][age][i])
  }

  for (let age = 0; age < pop.current.infectious.length; age++) {
    newPop.current.exposed[age] = Array(tdot.current.exposed[age].length)

    update(age, 'current', 'susceptible')
    for (let i = 0; i < pop.current.exposed[age].length; i++) {
      updateAt(age, 'current', 'exposed', i)
    }
    update(age, 'current', 'infectious')
    update(age, 'current', 'susceptible')
    update(age, 'current', 'severe')
    update(age, 'current', 'susceptible')
    update(age, 'current', 'critical')
    update(age, 'current', 'overflow')

    update(age, 'cumulative', 'hospitalized')
    update(age, 'cumulative', 'critical')
    update(age, 'cumulative', 'fatality')
    update(age, 'cumulative', 'recovered')
  }

  // Move hospitalized patients according to constrained resources
  // TODO(nnoll): The gradients aren't computed subject to this non-linear constraint
  let freeICUBeds = nICUBeds - sum(newPop.current.critical)

  for (let age = pop.current.critical.length - 1; freeICUBeds < 0 && age >= 0; age--) {
    if (newPop.current.critical[age] > -freeICUBeds) {
      newPop.current.critical[age] += freeICUBeds
      newPop.current.overflow[age] -= freeICUBeds
      freeICUBeds = 0
    } else {
      newPop.current.overflow[age] += newPop.current.critical[age]
      freeICUBeds += newPop.current.critical[age]
      newPop.current.critical[age] = 0
    }
  }

  for (let age = 0; freeICUBeds > 0 && age < pop.current.critical.length; age++) {
    if (newPop.current.overflow[age] > freeICUBeds) {
      newPop.current.critical[age] += freeICUBeds
      newPop.current.overflow[age] -= freeICUBeds
      freeICUBeds = 0
    } else {
      newPop.current.critical[age] += newPop.current.overflow[age]
      freeICUBeds -= newPop.current.overflow[age]
      newPop.current.overflow[age] = 0
    }
  }

  return newPop
}

function sumDerivatives(grads: TimeDerivative[], scale: number[]): TimeDerivative {
  const sum: TimeDerivative = {
    current: {
      susceptible: [],
      exposed: [],
      infectious: [],
      severe: [],
      critical: [],
      overflow: [],
    },
    cumulative: {
      hospitalized: [],
      critical: [],
      recovered: [],
      fatality: [],
    },
  }
  for (let age = 0; age < grads[0].current.susceptible.length; age++) {
    sum.current.susceptible[age] = 0
    sum.current.exposed[age] = grads[0].current.exposed[age].map(() => {
      return 0
    })
    sum.current.infectious[age] = 0
    sum.current.critical[age] = 0
    sum.current.overflow[age] = 0
    sum.current.severe[age] = 0

    sum.cumulative.critical[age] = 0
    sum.cumulative.fatality[age] = 0
    sum.cumulative.recovered[age] = 0
    sum.cumulative.hospitalized[age] = 0
  }

  grads.forEach((grad, i) => {
    for (let age = 0; age < grads[0].current.susceptible.length; age++) {
      sum.current.susceptible[age] += scale[i] * grad.current.susceptible[age]
      sum.current.infectious[age] += scale[i] * grad.current.infectious[age]
      grad.current.exposed[age].forEach((e, j) => {
        sum.current.exposed[age][j] += scale[i] * e
      })
      sum.current.severe[age] += scale[i] * grad.current.severe[age]
      sum.current.critical[age] += scale[i] * grad.current.critical[age]
      sum.current.overflow[age] += scale[i] * grad.current.overflow[age]

      sum.cumulative.recovered[age] += scale[i] * grad.cumulative.recovered[age]
      sum.cumulative.fatality[age] += scale[i] * grad.cumulative.fatality[age]
      sum.cumulative.critical[age] += scale[i] * grad.cumulative.critical[age]
      sum.cumulative.hospitalized[age] += scale[i] * grad.cumulative.hospitalized[age]
    }
  })

  return sum
}

function derivative(flux: StateFlux): TimeDerivative {
  const grad: TimeDerivative = {
    current: {
      susceptible: [],
      exposed: [],
      infectious: [],
      severe: [],
      critical: [],
      overflow: [],
    },
    cumulative: {
      recovered: [],
      hospitalized: [],
      critical: [],
      fatality: [],
    },
  }

  for (let age = 0; age < flux.susceptible.length; age++) {
    grad.current.exposed[age] = Array(flux.exposed[age].length)

    grad.current.susceptible[age] = -flux.susceptible[age]
    let fluxIn = flux.susceptible[age]
    flux.exposed[age].forEach((fluxOut, i) => {
      grad.current.exposed[age][i] = fluxIn - fluxOut
      fluxIn = fluxOut
    })
    grad.current.infectious[age] = fluxIn - flux.infectious.severe[age] - flux.infectious.recovered[age]
    grad.current.severe[age] =
      flux.infectious.severe[age] +
      flux.critical.severe[age] +
      flux.overflow.severe[age] -
      flux.severe.critical[age] -
      flux.severe.recovered[age]
    grad.current.critical[age] = flux.severe.critical[age] - flux.critical.severe[age] - flux.critical.fatality[age]
    grad.current.overflow[age] = -(flux.overflow.severe[age] + flux.overflow.fatality[age])

    // Cumulative categories
    grad.cumulative.recovered[age] = flux.infectious.recovered[age] + flux.severe.recovered[age]
    grad.cumulative.hospitalized[age] = flux.infectious.severe[age] + flux.infectious.severe[age]
    grad.cumulative.critical[age] = flux.severe.recovered[age] + flux.severe.recovered[age]
    grad.cumulative.fatality[age] = flux.critical.fatality[age] + flux.overflow.fatality[age]
  }

  return grad
}

function fluxes(time: Date, pop: SimulationTimePoint, P: ModelParams): StateFlux {
  const sum = (arr: number[]): number => {
    return arr.reduce((a, b) => a + b, 0)
  }

  // Convention: flux is labelled by the state
  const flux: StateFlux = {
    susceptible: [],
    exposed: [],
    infectious: {
      severe: [],
      recovered: [],
    },
    severe: {
      critical: [],
      recovered: [],
    },
    critical: {
      severe: [],
      fatality: [],
    },
    overflow: {
      severe: [],
      fatality: [],
    },
  }

  // Compute all fluxes (apart from overflow states) barring no hospital bed constraints
  const fracInfected = sum(pop.current.infectious) / P.populationServed

  for (let age = 0; age < pop.current.infectious.length; age++) {
    // Initialize all multi-faceted states with internal arrays
    flux.exposed[age] = Array(pop.current.exposed[age].length)

    // Susceptible -> Exposed
    flux.susceptible[age] =
      P.importsPerDay[age] +
      (1 - P.frac.isolated[age]) * P.rate.infection(time) * pop.current.susceptible[age] * fracInfected

    // Exposed -> Internal -> Infectious
    pop.current.exposed[age].forEach((exposed, i, exposedArray) => {
      flux.exposed[age][i] = P.rate.latency * exposed * exposedArray.length
    })

    // Infectious -> Recovered/Critical
    flux.infectious.recovered[age] = pop.current.infectious[age] * P.rate.recovery[age]
    flux.infectious.severe[age] = pop.current.infectious[age] * P.rate.severe[age]

    // Severe -> Recovered/Critical
    flux.severe.recovered[age] = pop.current.severe[age] * P.rate.discharge[age]
    flux.severe.critical[age] = pop.current.severe[age] * P.rate.critical[age]

    // Critical -> Severe/Fatality
    flux.critical.severe[age] = pop.current.critical[age] * P.rate.stabilize[age]
    flux.critical.fatality[age] = pop.current.critical[age] * P.rate.fatality[age]

    // Overflow -> Severe/Fatality
    flux.overflow.severe[age] = pop.current.overflow[age] * P.rate.stabilize[age]
    flux.overflow.fatality[age] = pop.current.overflow[age] * P.rate.overflowFatality[age]
  }

  return flux
}

const keys = <T>(o: T): Array<keyof T & string> => {
  return Object.keys(o) as Array<keyof T & string>
}

export function collectTotals(trajectory: SimulationTimePoint[], ages: string[]): ExportedTimePoint[] {
  const res: ExportedTimePoint[] = []

  trajectory.forEach((d) => {
    const tp: ExportedTimePoint = {
      time: d.time,
      current: {
        susceptible: {},
        severe: {},
        exposed: {},
        overflow: {},
        critical: {},
        infectious: {},
      },
      cumulative: {
        recovered: {},
        hospitalized: {},
        critical: {},
        fatality: {},
      },
    }

    // TODO(nnoll): Typescript linting isn't happy here
    Object.keys(tp.current).forEach((k) => {
      if (k === 'exposed') {
        tp.current[k].total = 0
        Object.values(d.current[k]).forEach((x) => {
          x.forEach((y) => {
            tp.current[k].total += y
          })
        })
        Object.keys(d.current[k]).forEach((a, i) => {
          tp.current[k][a] = d.current[k][i].reduce((a, b) => a + b, 0)
        })
      } else {
        ages.forEach((age, i) => {
          tp.current[k][age] = d.current[k][i]
        })
        tp.current[k].total = d.current[k].reduce((a, b) => a + b)
      }
    })

    Object.keys(tp.cumulative).forEach((k) => {
      ages.forEach((age, i) => {
        tp.cumulative[k][age] = d.cumulative[k][i]
      })
      tp.cumulative[k].total = d.cumulative[k].reduce((a, b) => a + b, 0)
    })

    res.push(tp)
  })

  return res
}

export function exportSimulation(result: UserResult) {
  // Store parameter values

  // Down sample trajectory to once a day.
  // TODO: Make the down sampling interval a parameter

  // Get all categories
  const categories = {
    current: keys(result.mean[0].current),
    cumulative: keys(result.mean[0].cumulative),
  }
  const header: string[] = ['time']
  categories.current.forEach((category) => {
    if (category == 'critical') {
      header.push(`ICU mean`, `ICU variance`)
    } else {
      header.push(`${category} mean`, `${category} lower bound`, `${category} upper bound`)
    }
  })
  categories.cumulative.forEach((category) => {
    header.push(
      `cumulative ${category} mean`,
      `cumulative ${category} lower bound`,
      `cumulative ${category} upper bound`,
    )
  })

  const tsv = [header.join('\t')]

  const seen: Record<string, boolean> = {}
  const upper = result.upper
  const lower = result.lower
  result.mean.forEach((mean, i) => {
    const t = new Date(mean.time).toISOString().slice(0, 10)
    if (t in seen) {
      return
    }
    seen[t] = true

    let buf = t
    categories.current.forEach((k) => {
      buf += `\t${Math.round(mean.current[k].total)}\t${Math.round(lower[i].current[k].total)}\t${Math.round(
        upper[i].current[k].total,
      )}`
    })
    categories.cumulative.forEach((k) => {
      buf += `\t${Math.round(mean.cumulative[k].total)}\t${Math.round(lower[i].cumulative[k].total)}\t${Math.round(
        upper[i].cumulative[k].total,
      )}`
    })

    tsv.push(buf)
  })

  return tsv.join('\n')
}
