// Mock livescore — one in-progress match showing live point score
export default [
    {
        event_key: '12124099',
        tournament_key: '3001',
        tournament_name: 'Roland Garros',
        event_date: '2026-05-25',
        event_time: '13:30',
        event_status: '1',
        tournament_round: 'Roland Garros - 1/32-finals',
        tournament_season: '2026',
        event_type_type: 'Atp Singles',
        event_first_player: 'C. Alcaraz',
        first_player_key: '2315',
        event_first_player_logo: '',
        event_second_player: 'H. Hurkacz',
        second_player_key: '2109',
        event_second_player_logo: '',
        event_final_result: '',
        event_winner: '',
        event_live: '1',
        pointbypoint: [
            { set_number: 'Set 1', number_game: '5', serve_winner: 'First Player', serve_lost: null, score: '4 - 1',
              points: [{ score: '40 - 15' }] },
            // Current game — no serve_winner yet
            { set_number: 'Set 1', number_game: '6', serve_winner: null, serve_lost: null, score: '4 - 2',
              points: [{ score: '0 - 0' }, { score: '15 - 0' }, { score: '30 - 0' }] },
        ],
    },
];
