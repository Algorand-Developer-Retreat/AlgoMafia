import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { Config, AlgorandClient } from '@algorandfoundation/algokit-utils';
// eslint-disable-next-line import/no-extraneous-dependencies
import * as algoring from 'algoring-ts';
import algosdk from 'algosdk';
import { createHash, randomBytes } from 'crypto';

import { TownHallClient, TownHallFactory } from '../contracts/clients/TownHallClient';
import {
  BLS12381G1_LENGTH,
  RING_SIG_CHALL_LENGTH,
  RING_SIG_NONCE_LENGTH,
  stateAssignRole,
  stateDawnStageDeadOrSaved,
  stateDawnStageDoctorReveal,
  stateDawnStageMafiaReveal,
  stateDawnStageUnmasking,
  stateDayStageEliminate,
  stateDayStageUnmasking,
  stateDayStageVote,
  stateGameOver,
  stateJoinGameLobby,
  stateNightStageDoctorCommit,
  stateNightStageMafiaCommit,
  ZERO_ADDRESS,
} from '../contracts/Constants';
import {
  joinGameLobby,
  Player,
  prepareLSigRingLink,
  unMaskDayStage,
  unMaskDawnStage,
  assignRole,
} from '../contracts/Utils';

const fixture = algorandFixture();
Config.configure({ populateAppCallResources: true });

let appClient: TownHallClient;

const fundAmount = (10).algo();

let players: Player[];

describe('TownHall', () => {
  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { testAccount } = fixture.context;
    const { algorand } = fixture;

    const factory = new TownHallFactory({
      algorand,
      defaultSender: testAccount.addr,
    });

    const createResult = await factory.send.create.createApplication();

    appClient = createResult.appClient;

    players = Array.from({ length: 6 }, () => new Player(appClient.appId));
    players.forEach(async (player) => {
      algorand.account.ensureFundedFromEnvironment(player.day_algo_address.account.addr, fundAmount);

      // TODO: Have the night address through an LSIG funded by the contract!
      algorand.account.ensureFundedFromEnvironment(player.night_algo_address.account.addr, fundAmount);
    });
  });

  test('NIZK DLOG Verification', async () => {
    const hardcodedProof = [
      new Uint8Array([
        // g, the generator. Could also be hardcoded into the contract to simplify things.
        23, 241, 211, 167, 49, 151, 215, 148, 38, 149, 99, 140, 79, 169, 172, 15, 195, 104, 140, 79, 151, 116, 185, 5,
        161, 78, 58, 63, 23, 27, 172, 88, 108, 85, 232, 63, 249, 122, 26, 239, 251, 58, 240, 10, 219, 34, 198, 187, 8,
        179, 244, 129, 227, 170, 160, 241, 160, 158, 48, 237, 116, 29, 138, 228, 252, 245, 224, 149, 213, 208, 10, 246,
        0, 219, 24, 203, 44, 4, 179, 237, 208, 60, 199, 68, 162, 136, 138, 228, 12, 170, 35, 41, 70, 197, 231, 225,
      ]),
      new Uint8Array([
        // x, the "public key" of the player's private key. Should be kept in the contract afterwards for the ring sig.
        7, 122, 95, 31, 116, 69, 4, 0, 55, 44, 1, 3, 202, 39, 80, 43, 92, 5, 234, 160, 108, 74, 168, 65, 1, 22, 218,
        119, 132, 149, 161, 235, 183, 189, 31, 108, 187, 170, 225, 104, 191, 154, 5, 69, 173, 250, 178, 115, 21, 175,
        15, 16, 21, 57, 45, 0, 35, 249, 121, 250, 4, 124, 229, 231, 50, 158, 160, 12, 22, 206, 190, 41, 106, 102, 22,
        199, 119, 108, 39, 81, 211, 193, 255, 3, 182, 55, 84, 79, 184, 0, 171, 248, 103, 56, 131, 196,
      ]),
      new Uint8Array([
        // v (= g^r), the point-version of the nonce
        4, 71, 43, 242, 239, 119, 227, 5, 14, 23, 89, 101, 39, 197, 220, 59, 233, 222, 216, 118, 165, 92, 34, 36, 196,
        91, 201, 8, 156, 23, 188, 204, 64, 11, 131, 129, 195, 54, 74, 222, 15, 232, 136, 22, 104, 151, 112, 31, 0, 77,
        94, 47, 187, 221, 178, 159, 61, 224, 239, 254, 81, 11, 187, 84, 217, 79, 164, 24, 211, 231, 28, 138, 31, 95,
        182, 94, 162, 175, 67, 172, 71, 49, 220, 209, 161, 100, 112, 55, 9, 66, 77, 227, 139, 120, 221, 207,
      ]), // z, the core proof
      new Uint8Array([
        104, 3, 67, 33, 21, 217, 58, 26, 12, 171, 12, 50, 3, 19, 73, 21, 196, 233, 226, 35, 249, 172, 101, 253, 145,
        215, 177, 107, 178, 242, 108, 35,
      ]),
    ];

    const simulateNIZKCall = await appClient
      .newGroup()
      .dlog({
        args: { g: hardcodedProof[0], x: hardcodedProof[1], v: hardcodedProof[2], z: hardcodedProof[3] },
      })
      .simulate({
        extraOpcodeBudget: 5650,
      });

    expect(simulateNIZKCall.returns[0]).toBe(true);
  });

  test('hashPointToPoint', async () => {
    const inputPoint = algoring.to_pxpy(
      new Uint8Array([
        129, 119, 132, 19, 185, 32, 6, 229, 84, 7, 31, 32, 239, 187, 118, 12, 109, 123, 234, 165, 95, 213, 254, 114,
        217, 182, 228, 87, 167, 229, 30, 148, 86, 253, 18, 12, 44, 12, 4, 130, 128, 61, 218, 57, 199, 47, 227, 167,
      ])
    );

    const expectedPoint = algoring.to_pxpy(
      new Uint8Array([
        153, 147, 4, 225, 116, 61, 24, 64, 22, 31, 12, 65, 244, 78, 19, 85, 234, 199, 84, 11, 186, 208, 132, 146, 106,
        8, 145, 4, 22, 2, 197, 91, 24, 136, 80, 147, 150, 180, 136, 6, 63, 189, 9, 178, 238, 112, 220, 167,
      ])
    );

    const simulateHashCall = await appClient
      .newGroup()
      .hashPointToPoint({
        args: { point: inputPoint },
      })
      .simulate({
        extraOpcodeBudget: 1500,
      });

    const newPoint = simulateHashCall.returns[0];
    if (!newPoint) {
      throw new Error('newPoint is undefined');
    }

    expect(newPoint.toString()).toStrictEqual(expectedPoint.toString());
  });

  test('entire_play', async () => {
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateJoinGameLobby);

    // TODO: have users fund the contract as part of their deposit!
    await AlgorandClient.defaultLocalNet().account.ensureFundedFromEnvironment(appClient.appAddress, fundAmount);
    // E.g., like so (but include signer):
    // const mbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    //   from: player.day_algo_address.addr,
    //   to: appClient.appAddress,
    //   amount: ....,
    //   suggestedParams: await AlgorandClient.defaultLocalNet().getSuggestedParams(),
    // });

    // eslint-disable-next-line no-restricted-syntax
    for (const player of players) {
      // eslint-disable-next-line no-await-in-loop
      await joinGameLobby(player.day_client, player.bls_private_key);
    }

    expect(await appClient.state.global.player1AlgoAddr()).toBe(players[0].day_algo_address.addr);
    expect(await appClient.state.global.player2AlgoAddr()).toBe(players[1].day_algo_address.addr);
    expect(await appClient.state.global.player3AlgoAddr()).toBe(players[2].day_algo_address.addr);
    expect(await appClient.state.global.player4AlgoAddr()).toBe(players[3].day_algo_address.addr);
    expect(await appClient.state.global.player5AlgoAddr()).toBe(players[4].day_algo_address.addr);
    expect(await appClient.state.global.player6AlgoAddr()).toBe(players[5].day_algo_address.addr);

    const ring = await appClient.state.box.quickAccessPkBoxes.value(0);
    if (!ring) {
      throw new Error('ring is undefined');
    }
    expect(ring.length).toBe(BLS12381G1_LENGTH * 6);
    // TODO: Refactor and make sure that the same player can't join twice lol

    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateAssignRole); // Advanced to the AssignRoles stage
    /// <----------- ENTERED AssignRole Stage ----------->

    const ringOfPKs = [
      algoring.from_pxpy(ring.slice(0 * BLS12381G1_LENGTH, 1 * BLS12381G1_LENGTH)),
      algoring.from_pxpy(ring.slice(1 * BLS12381G1_LENGTH, 2 * BLS12381G1_LENGTH)),
      algoring.from_pxpy(ring.slice(2 * BLS12381G1_LENGTH, 3 * BLS12381G1_LENGTH)),
      algoring.from_pxpy(ring.slice(3 * BLS12381G1_LENGTH, 4 * BLS12381G1_LENGTH)),
      algoring.from_pxpy(ring.slice(4 * BLS12381G1_LENGTH, 5 * BLS12381G1_LENGTH)),
      algoring.from_pxpy(ring.slice(5 * BLS12381G1_LENGTH, 6 * BLS12381G1_LENGTH)),
    ];

    // eslint-disable-next-line no-restricted-syntax
    for (const player of players) {
      const msg = Buffer.concat([
        algosdk.decodeAddress(player.night_algo_address.addr).publicKey,
        algosdk.decodeAddress(player.night_client.appClient.appAddress).publicKey,
      ]);

      // TODO: Remove genKeyImage's PK input, it should be directly generated from SK.
      const keyImage = algoring.genKeyImage(player.bls_private_key, player.bls_public_key);

      // TODO: Remove KeyImage return since it is superfluous OR KeyImage input
      const { signature } = algoring.generate_ring_signature(msg, player.bls_private_key, ringOfPKs, keyImage);

      expect(algoring.verify_ring_signature(msg, signature, ringOfPKs, keyImage)).toBe(true);

      // TODO: remove msg return
      const { signatureConcat, intermediateValues } = algoring.construct_avm_ring_signature(
        msg,
        signature,
        ringOfPKs,
        keyImage
      );

      // BEGIN LSIG

      const pts = [];
      const signers = [];

      const length = intermediateValues.length / RING_SIG_CHALL_LENGTH;

      // eslint-disable-next-line no-plusplus
      for (let i = 0; i < length; i++) {
        // eslint-disable-next-line no-await-in-loop
        const { lSigRingSigPayTxn, lSigRingSigSigner } = await prepareLSigRingLink(
          i,
          player.night_client,
          msg,
          ring.slice(i * BLS12381G1_LENGTH, (i + 1) * BLS12381G1_LENGTH),
          keyImage,
          signatureConcat.slice((i + 1) * RING_SIG_NONCE_LENGTH, (i + 2) * RING_SIG_NONCE_LENGTH),
          intermediateValues.slice(i * RING_SIG_CHALL_LENGTH, (i + 1) * RING_SIG_CHALL_LENGTH),
          i === length - 1
            ? intermediateValues.slice(0 * RING_SIG_CHALL_LENGTH, 1 * RING_SIG_CHALL_LENGTH)
            : intermediateValues.slice((i + 1) * RING_SIG_CHALL_LENGTH, (i + 2) * RING_SIG_CHALL_LENGTH)
        );
        pts.push(lSigRingSigPayTxn);
        signers.push(lSigRingSigSigner);
      }

      // eslint-disable-next-line no-await-in-loop
      await assignRole(
        player.night_client,
        msg,
        ring,
        keyImage,
        signatureConcat,
        intermediateValues,
        pts,
        signers,
        length
      );
    }

    // <----->

    expect(await appClient.state.global.mafia()).toBe(players[0].night_algo_address.addr);
    expect(await appClient.state.global.doctor()).toBe(players[1].night_algo_address.addr);
    expect(await appClient.state.global.farmer()).toBe(players[2].night_algo_address.addr);
    expect(await appClient.state.global.butcher()).toBe(players[3].night_algo_address.addr);
    expect(await appClient.state.global.innkeep()).toBe(players[4].night_algo_address.addr);
    expect(await appClient.state.global.grocer()).toBe(players[5].night_algo_address.addr);

    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDayStageVote); // Advanced to the DayStageVote stage

    /// <----------- ENTERED DayStageVote ----------->

    // Everyone but player 3 votes for player 3
    // Player 3 votes for player 1 ( who just happens to be the maffia)
    await players[0].day_client.send.dayStageVote({ args: { vote: 3 } });
    await players[1].day_client.send.dayStageVote({ args: { vote: 3 } });
    await players[2].day_client.send.dayStageVote({ args: { vote: 1 } });
    await players[3].day_client.send.dayStageVote({ args: { vote: 3 } });
    await players[4].day_client.send.dayStageVote({ args: { vote: 3 } });
    await players[5].day_client.send.dayStageVote({ args: { vote: 3 } });

    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDayStageEliminate); // Advanced to the DayStageEliminate stage

    /// <----------- ENTERED DayStageEliminate ----------->
    // Player 3 is eliminated
    await players[0].day_client.send.dayStageEliminate(); // Doesn't matter who calls it
    expect(await appClient.state.global.player3AlgoAddr()).toEqual(ZERO_ADDRESS);
    expect(Number(await appClient.state.global.playersAlive())).toEqual(5);
    expect(await appClient.state.global.justEliminatedPlayer()).toStrictEqual(players[2].day_algo_address.addr);
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDayStageUnmasking); // Advanced to the DayStageUnmasking stage

    /// <----------- ENTERED DayStageUnmasking ----------->
    // Player 3 reveals themselves

    await unMaskDayStage(players[2].day_client, players[2].bls_private_key);

    expect(await appClient.state.global.justEliminatedPlayer()).toEqual(ZERO_ADDRESS);
    expect((await appClient.state.global.doctor()) === ZERO_ADDRESS).toBeFalsy();
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateNightStageMafiaCommit); // Advanced to the NightStageMafiaCommit stage

    /// <----------- ENTERED NightStageMafiaCommit ----------->
    // Mafia commits to value

    let mafiaCommitBlinder = randomBytes(32);
    let playerToKill = players[3].day_algo_address.addr;

    // Hash the concatenated data using sha256
    let mafiaCommitHash = createHash('sha256')
      .update(Buffer.concat([algosdk.decodeAddress(playerToKill).publicKey, mafiaCommitBlinder]))
      .digest();

    await players[0].night_client.send.nightStageMafiaCommit({
      args: {
        commitment: mafiaCommitHash,
      },
    });

    expect((await appClient.state.global.mafiaCommitment()).asByteArray()).toStrictEqual(
      new Uint8Array(mafiaCommitHash)
    );
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateNightStageDoctorCommit); // Advanced to the Night Stage Doctor Commit

    /// <----------- ENTERED NightStageDoctorCommit ----------->

    let doctorCommitBlinder = randomBytes(32);
    let playerToSave = players[4].day_algo_address.addr;

    let doctorCommitHash = createHash('sha256')
      .update(Buffer.concat([algosdk.decodeAddress(playerToSave).publicKey, doctorCommitBlinder]))
      .digest();

    await players[1].night_client.send.nightStageDoctorCommit({
      args: {
        commitment: doctorCommitHash,
      },
    });

    expect((await appClient.state.global.doctorCommitment()).asByteArray()).toStrictEqual(
      new Uint8Array(doctorCommitHash)
    );
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDawnStageMafiaReveal); // Advanced to the Dawn Stage Mafia Reveal
    /// <----------- ENTERED DawnStageMafiaReveal ----------->

    await players[0].night_client.send.dawnStageMafiaReveal({
      args: { victimAim: playerToKill, blinder: new Uint8Array(mafiaCommitBlinder) },
    });

    expect((await appClient.state.global.mafiaVictim()) === playerToKill);
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDawnStageDoctorReveal); // Advanced to the Dawn Stage Doctor Reveal

    /// <----------- ENTERED DawnStageDoctorReveal ----------->

    await players[1].night_client.send.dawnStageDoctorReveal({
      args: { patientAim: playerToSave, blinder: new Uint8Array(doctorCommitBlinder) },
    });

    expect((await appClient.state.global.doctorPatient()) === playerToSave);
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDawnStageDeadOrSaved); // Advanced to the Dawn Stage Dead Or Saved

    /// <----------- ENTERED DawnStageDeadOrSaved----------->

    await players[0].day_client.send.dawnStageDeadOrSaved(); // Anyone can call it

    expect(Number(await appClient.state.global.playersAlive())).toEqual(4);
    expect(await appClient.state.global.mafiaVictim()).toEqual(ZERO_ADDRESS);
    expect(await appClient.state.global.doctorPatient()).toEqual(ZERO_ADDRESS);
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDawnStageUnmasking); // Advanced to Dawn Stage Unmasking
    /// <----------- ENTERED DawnStageUnmasking----------->

    await unMaskDawnStage(players[3].day_client, players[3].bls_private_key);

    expect(await appClient.state.global.justEliminatedPlayer()).toEqual(ZERO_ADDRESS);
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDayStageVote); // Advanced back to DayStageVote

    /// <----------- ENTERED DayStageVote----------->

    await players[0].day_client.send.dayStageVote({ args: { vote: 6 } });
    await players[1].day_client.send.dayStageVote({ args: { vote: 6 } });
    // players[2] <--- player is dead
    // players[3] <--- player is dead
    await players[4].day_client.send.dayStageVote({ args: { vote: 6 } });
    await players[5].day_client.send.dayStageVote({ args: { vote: 6 } });

    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDayStageEliminate); // Advanced to the DayStageEliminate stage

    /// <----------- ENTERED DayStageEliminate----------->
    // Player 6 is eliminated
    await players[5].day_client.send.dayStageEliminate(); // Doesn't matter who calls it
    expect(await appClient.state.global.player6AlgoAddr()).toEqual(ZERO_ADDRESS);
    expect(Number(await appClient.state.global.playersAlive())).toEqual(3);
    expect(await appClient.state.global.justEliminatedPlayer()).toStrictEqual(players[5].day_algo_address.addr);
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDayStageUnmasking); // Advanced to the DayStageUnmasking stage

    /// <----------- ENTERED DayStageUnmasking ----------->
    // Player 6 reveals themselves

    await unMaskDayStage(players[5].day_client, players[5].bls_private_key);

    expect(await appClient.state.global.justEliminatedPlayer()).toEqual(ZERO_ADDRESS);
    expect((await appClient.state.global.doctor()) === ZERO_ADDRESS).toBeFalsy();
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateNightStageMafiaCommit); // Advanced to the NightStageMafiaCommit stage

    /// <----------- ENTERED NightStageMafiaCommit ----------->
    // Mafia commits to value

    mafiaCommitBlinder = randomBytes(32);
    playerToKill = players[4].day_algo_address.addr;

    // Hash the concatenated data using sha256
    mafiaCommitHash = createHash('sha256')
      .update(Buffer.concat([algosdk.decodeAddress(playerToKill).publicKey, mafiaCommitBlinder]))
      .digest();

    await players[0].night_client.send.nightStageMafiaCommit({
      args: {
        commitment: mafiaCommitHash,
      },
    });

    expect((await appClient.state.global.mafiaCommitment()).asByteArray()).toStrictEqual(
      new Uint8Array(mafiaCommitHash)
    );
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateNightStageDoctorCommit); // Advanced to the Night Stage Doctor Commit

    /// <----------- ENTERED NightStageDoctorCommit ----------->

    doctorCommitBlinder = randomBytes(32);
    playerToSave = players[1].day_algo_address.addr;

    doctorCommitHash = createHash('sha256')
      .update(Buffer.concat([algosdk.decodeAddress(playerToSave).publicKey, doctorCommitBlinder]))
      .digest();

    await players[1].night_client.send.nightStageDoctorCommit({
      args: {
        commitment: doctorCommitHash,
      },
    });

    expect((await appClient.state.global.doctorCommitment()).asByteArray()).toStrictEqual(
      new Uint8Array(doctorCommitHash)
    );
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDawnStageMafiaReveal); // Advanced to the Dawn Stage Mafia Reveal
    /// <----------- ENTERED DawnStageMafiaReveal ----------->

    await players[0].night_client.send.dawnStageMafiaReveal({
      args: { victimAim: playerToKill, blinder: new Uint8Array(mafiaCommitBlinder) },
    });

    expect((await appClient.state.global.mafiaVictim()) === playerToKill);
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDawnStageDoctorReveal); // Advanced to the Dawn Stage Doctor Reveal

    /// <----------- ENTERED DawnStageDoctorReveal ----------->

    await players[1].night_client.send.dawnStageDoctorReveal({
      args: { patientAim: playerToSave, blinder: new Uint8Array(doctorCommitBlinder) },
    });

    expect((await appClient.state.global.doctorPatient()) === playerToSave);
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateDawnStageDeadOrSaved); // Advanced to the Dawn Stage Dead Or Saved

    /// <----------- ENTERED DawnStageDeadOrSaved----------->

    await players[1].day_client.send.dawnStageDeadOrSaved(); // Anyone can call it

    expect(Number(await appClient.state.global.playersAlive())).toEqual(2);
    expect(await appClient.state.global.mafiaVictim()).toEqual(ZERO_ADDRESS);
    expect(await appClient.state.global.doctorPatient()).toEqual(ZERO_ADDRESS);
    expect(Number((await appClient.send.getGameState()).return)).toEqual(stateGameOver); // Advanced to Game Over
  });
});

/**


  ## Create a new game
    * create TownHall contract
    * create lsig funder contract
    * Set the slots for the roles: Mafia (1), Townsfolk (3), Doctor (1)
    * Set the minimum deposit for the game

  ## Lobby stage
    * each player provides their BLS12_381 public key
    * each player deposits a minimum required amount of ALGO
    * each player also deposits a minimum required amount of ALGO in the lsig to fund the ring sigs

  ## Assign the Roles
    * each player produces a ring sig in a virgin account, using an lsig funder.
    * the contract (randomly?) assigns the roles to the players

  ## Day Stage
    * if there are equal or more mafia than townsfolk+doctor, the mafia wins
    * each player votes for a player
    * the player with the most votes is eliminated; they are removed from the game
    * the player reveals their role to retrieve their deposit
    * if there are no mafia left, the townsfolk win

  ## Night Stage
    * the mafia commit to a user by generating a random nonce, concatenating it with the user's public key, hashing it and sending it to the contract
    * the doctor commits to a user by generating a random nonce, concatenating it with the user's public key, and hashing it and sending it to the contract

  ## Dawn Stage
    * the mafia and doctor reveal heir commitment. If the doctor committed to the same player as the mafia, the user is saved. Otherwise, the player is killed.

  ## End Game
    * Decommision the contract
    * Return any remaining funds to the players

  Repeat ^



 */
